import * as fs from 'fs';
import { Readable } from 'stream';
import { ethers, Contract, Wallet, BigNumber } from 'ethers';
import { base64 } from '@scure/base';
import axios from 'axios';
import * as http_client from 'ipfs-http-client';
import Config from './config.json';
import { log } from './log';
import {
  dbGarbageCollect,
  dbGetJobs,
  dbGetTask,
  dbGetTaskTxid,
  dbGetTaskInput,
  dbGetInvalidTask,
  dbGetSolution,
  dbGetContestation,
  dbGetContestationVotes,
  dbStoreTask,
  dbStoreTaskTxid,
  dbStoreInvalidTask,
  dbStoreTaskInput,
  dbStoreSolution,
  dbStoreContestation,
  dbStoreContestationVote,
  dbStoreFailedJob,
  dbQueueJob,
  dbDeleteJob,
  dbClearJobsByMethod,
  dbUpdateTaskSetRetracted,
} from './db';

import {
  // AnythingV3Model,
  // ZeroscopeModel,
  Kandinsky2Model,
  getModelById,
  checkModelFilter,
  hydrateInput,
} from './models';

import { pinFileToIPFS } from './ipfs';

import {
  sleep,
  now,
  taskid2Seed,
  expretry,
  generateCommitment,
} from './utils';

import {
  MiningConfig,
  Task,
  Solution,
  Job,
  Model,
  QueueJobProps,
  DBTask,
  DBInvalidTask,
  DBSolution,
  DBContestation,
  DBContestationVote,
  DBTaskInput,
  DBJob,
} from './types';

import { c } from './mc';

import { replicate } from './ml';

import {
  wallet,
  arbius,
  token,
  // governor,
  solver,
  getBlockNumber,
  depositForValidator,
  getValidatorStaked,
} from './blockchain';

// type interfaces;
interface LookupResult {
  model: string;
  cid: string;
}

interface TaskInput {
  data: string;
}

interface SolutionDetails {
  cid: string;
}

ethers.utils.Logger.setLogLevel(ethers.utils.Logger.levels.DEBUG);

const minerVersion = BigNumber.from('2');

const EnabledModels = [
  /*
  {
    ...AnythingV3Model,
    filters: [
      {
        minfee: ethers.utils.parseEther('0'),
        mintime: 0,
      },
    ],
    getfiles: async (m: Model, taskid: string, input: any) => {
      return await mlStrategyReplicate(m, taskid, input, async (output) => {
        const url = output![0];
        const res = await expretry(async () => await axios.get(url, {
          responseType: 'arraybuffer'
        }));

        if (! res) {
          throw new Error('unable to getfiles');
        }

        const path = 'out-1.png';
        fs.writeFileSync(`${__dirname}/../cache/${path}`, res.data);

        return [path];
      });
    },
  },
  */
  /*
  {
    ...ZeroscopeModel,
    filters: [
      {
        minfee: ethers.utils.parseEther('0'),
        mintime: 0,
      },
    ],
    getfiles: async (m: Model, taskid: string, input: any) => {
      const url = 'http://192.9.239.212:8001/predictions';
      const res = await axios.post(url, { timeout: 120_000, input });

      if (! res) {
        throw new Error('unable to getfiles');
      }

      if (res.data.output.length != 1) {
        throw new Error('unable to getfiles -- data.output length not 1');
      }

      // slice off
      // data:image/png;base64,
      const b64data = res.data.output[0];
      const data = b64data.replace(/^data:\w+\/\w+;base64,/, "");
      const buf = Buffer.from(data, 'base64');

      const path = 'out-1.mp4';
      fs.writeFileSync(`${__dirname}/../cache/${path}`, buf);

      return [path];
    },
  },
  */
  {
    ...Kandinsky2Model,
    filters: [
      {
        minfee: ethers.utils.parseEther('0'),
        mintime: 0,
      },
    ],
    getfiles: async (m: Model, taskid: string, input: any) => {
      const url = c.ml.cog[Config.models.kandinsky2.id].url;
      console.log(url,"url")
      const res = await axios.post(url, { input });

      if (! res) {
        throw new Error('unable to getfiles');
      }


      if (res.data.output.length != 1) {
        throw new Error('unable to getfiles -- data.output length not 1');
      }

      // slice off
      // data:image/png;base64,
      const b64data = res.data.output[0];
      const data = b64data.replace(/^data:\w+\/\w+;base64,/, "");
      const buf = Buffer.from(data, 'base64');

      const path = 'out-1.png';
      fs.writeFileSync(`${__dirname}/../${c.cache_path}/${path}`, buf);

      return [path];
    },
  },
];

async function lookupAndInsertTask(taskid: string): Promise<Task> {
  return new Promise(async (resolve, reject) => {
    log.debug(`lookupAndInsertTask ${taskid}`);
    const existing = await dbGetTask(taskid);
    if (existing) {
      log.debug(`Task (${taskid}) already in db`);
      return resolve({
        model:     existing.modelid,
        fee:       BigNumber.from(existing.fee),
        owner:     existing.address,
        blocktime: BigNumber.from(existing.blocktime),
        version:   existing.version,
        cid:       existing.cid,
      });
    }

    log.debug(`looking up task from blockchain ${taskid}`);
    const {
      model,
      fee,
      owner,
      blocktime,
      version,
      cid,
    } = await expretry(async () => await arbius.tasks(taskid));

    log.debug(`lookupAndInsertTask inserting ${taskid}`);
    await dbStoreTask({
      taskid,
      modelid: model,
      fee,
      owner,
      blocktime,
      version,
      cid,
    });

    resolve({
      model,
      fee,
      owner,
      blocktime,
      version,
      cid,
    });
  });
}


async function lookupAndInsertTaskInput(
  taskid: string,
  cid: string,
  txid: string|null,
  modelTemplate: any,
) {
  if (txid === null) {
    txid = await dbGetTaskTxid(taskid);
  }
  if (txid === null) {
    log.warn(`Task (${taskid}) has no txid`);
    return;
  }
  let input: any;

  const cachedInput = await dbGetTaskInput(taskid, cid);
  if (cachedInput !== null) {
    log.debug(`Task (${taskid}) CID (${cid}) loaded from cache`);
    input = JSON.parse(cachedInput.data);
    return input;
  }

  log.debug(`Task (${taskid}) CID (${cid}) being loaded from TXID (${txid})`);
  // will be populated from task cid when downloaded
  let preprocessed_str = null;
  let preprocessed_obj = null;

  const tx = await expretry(async () => await arbius.provider.getTransaction(txid!));
  if (! tx) {
    throw new Error('unable to retrieve tx');
  }
  const parsed = arbius.interface.parseTransaction(tx);

  try {
    preprocessed_str = Buffer.from(parsed.args.input_.substring(2), 'hex').toString();
    preprocessed_obj = JSON.parse(preprocessed_str);
  } catch (e) {
    log.warn(`Task (${taskid}) request was unable to be parsed`);
    await dbStoreInvalidTask(taskid);
    return null;
  }

  const hydrated = hydrateInput(preprocessed_obj, modelTemplate);
  if (hydrated.err) {
    log.warn(`Task (${taskid}) hydration error ${hydrated.errmsg}`);
    await dbStoreInvalidTask(taskid);
    return null;
  }

  input = hydrated.input;
  input.seed = taskid2Seed(taskid);
  await dbStoreTaskInput(taskid, cid, input);

  await dbQueueJob({
    method: 'pinTaskInput',
    priority: 10,
    waituntil: now(),
    concurrent: true,
    data: {
      taskid,
      input: preprocessed_str,
    },
  });

  return input;
}

let alreadySeenTaskTx = new Set<string>();
async function eventHandlerTaskSubmitted(
  taskid: string,
  evt: ethers.Event,
) {
  // this is needed in contestations so we can look up the input
  dbStoreTaskTxid(taskid, evt.transactionHash);

  if (Math.random() < (1-c.prob.task)) {
    // log.debug(`Task ${taskid} skipped`);
    return;
  }
  log.debug('Event.TaskSubmitted', taskid);
  // log.debug(evt);

  if (alreadySeenTaskTx.has(evt.transactionHash)) {
    log.error("alreadySeenTaskTx", evt.transactionHash);
    log.error("taskid", taskid);
    return;
  } else {
    alreadySeenTaskTx.add(evt.transactionHash);
  }

  const task = await lookupAndInsertTask(taskid);
  const txid = evt.transactionHash;

  const queued = await dbQueueJob({
    method: 'task',
    priority: 10,
    waituntil: now(),
    concurrent: false,
    data: {
      taskid,
      txid,
    },
  });
  // console.log(queued);
}

async function eventHandlerTaskRetracted(taskid: string, evt: ethers.Event) {
  if (Math.random() < (1-c.prob.task_retracted)) {
    // log.debug(`TaskRetracted ${taskid} skipped`);
    return;
  }
  log.debug('Event.TaskRetracted', taskid);

  return new Promise(async (resolve, reject) => {
    const existing = await dbGetTask(taskid);
    if (! existing) {
      log.debug(`Task (${taskid}) not in db, looking up`);
      await lookupAndInsertTask(taskid);
    }

    const {
      model,
      fee,
      owner,
      blocktime,
      version,
      cid,
    } = await expretry(async () => await arbius.tasks(taskid));

    await dbUpdateTaskSetRetracted(taskid);
  });
}

let alreadySeenSolutionTx = new Set<string>();
async function eventHandlerSolutionSubmitted(taskid: string, evt: ethers.Event) {
  // log.debug(evt);
  if (Math.random() < (1-c.prob.solution_submitted)) {
    // log.debug(`SolutionSubmitted ${taskid} skipped`);
    return;
  }
  log.debug('Event.SolutionSubmitted', taskid);

  if (alreadySeenSolutionTx.has(evt.transactionHash)) {
    log.error("alreadySeenSolutionTx", evt.transactionHash);
    log.error("taskid", taskid);
    return;
  } else {
    alreadySeenSolutionTx.add(evt.transactionHash);
  }

  dbQueueJob({
    method: 'solution',
    priority: 20,
    waituntil: now(),
    concurrent: false,
    data: {
      taskid,
    },
  });

}


async function eventHandlerContestationSubmitted(
  validator: string,
  taskid: string,
  evt: ethers.Event,
) {
  if (Math.random() < (1-c.prob.contestation_submitted)) {
    // log.debug(`ContestationSubmitted ${taskid} skipped`);
    return;
  }
  log.error("eventHandlerContestationSubmitted", validator, taskid);

  await dbQueueJob({
    method: 'contestationVoteFinish',
    priority: 200,
    waituntil: now()+5010,
    concurrent: false,
    data: {
      taskid,
    },
  });

  await dbQueueJob({
    method: 'contestation',
    priority: 100,
    waituntil: now(),
    concurrent: false,
    data: {
      validator,
      taskid,
    },
  });

}


async function eventHandlerContestationVote(
  validator: string,
  taskid: string,
  yea: boolean,
  evt: ethers.Event,
) {
  log.error('Event.ContestationVote', validator, taskid, yea);

  return new Promise(async (resolve, reject) => {
    {
      const rows = await dbGetContestationVotes(taskid);
      for (let row of rows) {
        if (row.validator === validator) {
          log.debug(`Contestation Vote ${taskid}-${validator} already in db`);
          return resolve(true);
        }
      }
    }

    await dbStoreContestationVote({
      taskid,
      validator,
      yea,
    });
  });
}

/*
async function eventHandlerGovernanceProposalCreated(
  proposalId: string,
  evt: ethers.Event,
) {
  log.debug('Event.ProposalCreated', proposalId);
  const txid = evt.transactionHash;

  const tx = await expretry(async () => await governor.provider.getTransaction(txid));
  if (! tx) {
    throw new Error('unable to retrieve tx');
  }
  const parsed = governor.interface.parseTransaction(tx);
  log.debug('parsed', parsed);

  const description = parsed.args[3];
  log.debug('description', description);

  await dbQueueJob({
    method: 'pinGovernanceProposal',
    priority: 100,
    waituntil: 0,
    concurrent: true,
    data: {
      proposalId,
      description,
    },
  });
}

async function processPinGovernanceProposal(
  proposalId: string,
  description: string,
) {
  const cid = await expretry(async () => await pinFileToIPFS(
    c,
    Buffer.from(description, 'utf-8'),
    `proposal-${proposalId}.md`,
  ));

  log.debug(`Governance proposal ${proposalId} pinned with ${cid}`);
}
*/

async function processPinTaskInput(
  taskid: string,
  input: string,
) {
  const cid = await expretry(async () => await pinFileToIPFS(
    c,
    Buffer.from(input, 'utf-8'),
    `task-${taskid}.json`,
  ));

  log.debug(`Task input ${taskid} pinned with ${cid}`);
}

let alreadyFinishedContestationVote = new Set<string>();
async function processContestationVoteFinish(
  taskid: string,
) {
  if (alreadyFinishedContestationVote.has(taskid)) {
    return;
  }
  if (Math.random() < (1-c.prob.contestation_vote_finish)) {
    log.debug(`ContestationVoteFinish ${taskid} skipped`);
    return;
  }
  alreadyFinishedContestationVote.add(taskid);
  log.debug('processContestationVoteFinish', taskid);

  // how many to process at time
  const amnt = 16;
  await expretry(async () => arbius.contestationVoteFinish(taskid, amnt), 3, 1.25);
  log.debug(`ContestationVoteFinish ${taskid} finished`);
}

async function processValidatorStake() {
  if (c.read_only) {
    log.info(`Read only mode, not checking stake`);
    return;
  }
  const etherBalance = await arbius.provider.getBalance(wallet.address);
  log.debug(`[balcheck] Ether balance: ${ethers.utils.formatEther(etherBalance)}`);

  if (etherBalance.lt(ethers.utils.parseEther("0.01"))) {
    log.warn(`[balcheck] Low Ether balance`);
  }

  const staked = await getValidatorStaked();
  log.debug(`[balcheck] AIUS Staked: ${ethers.utils.formatEther(staked)}`);

  const validatorMinimum = await expretry(async () => await arbius.getValidatorMinimum());
  log.debug(`[balcheck] Validator Minimum: ${ethers.utils.formatEther(validatorMinimum)}`);

  // schedule checking every 2 mins
  await dbQueueJob({
    method: 'validatorStake',
    priority: 1000,
    waituntil: now()+120,
    concurrent: false,
    data: {
      validatorMinimum,
    },
  });

  const minWithTopupBuffer = validatorMinimum
    .mul(100)
    .div(100 - c.stake_buffer_topup_percent);

  if (staked.gte(minWithTopupBuffer)) {
    log.debug(`[balcheck] Have sufficient stake`);
    return;
  }

  const minWithBuffer = validatorMinimum
    .mul(100)
    .div(100 - c.stake_buffer_percent);

  const depositAmount = minWithBuffer.sub(staked);
  log.debug(`[balcheck] Deposit Amount ${ethers.utils.formatEther(depositAmount)}`);

  const balance = await expretry(async () => await token.balanceOf(wallet.address));
  if (balance.lt(depositAmount)) {
    log.error(`[balcheck] Balance ${ethers.utils.formatEther(balance)} less than deposit amount ${ethers.utils.formatEther(depositAmount)}`);
    throw new Error('unable to stake required balance');
  }

  const allowance = await expretry(async () => await token.allowance(
    wallet.address,
    solver.address, // could be engine or delegated validator
  ));
  log.debug(`[balcheck] Allowance Amount ${ethers.utils.formatEther(allowance)}`);

  if (allowance.lt(balance)) {
    const allowanceAmount = ethers.constants.MaxUint256.sub(allowance);

    log.debug(`[balcheck] Increasing allowance`);
    await expretry(async () => {
      const tx = await expretry(async () => await token.approve(
        solver.address,
        allowanceAmount,
      ));
      const receipt = await tx.wait();
      log.info(`[balcheck] Allowance increased in ${receipt.transactionHash}`);
    });
  }

  log.debug(`[balcheck] Depositing for validator stake ${ethers.utils.formatEther(depositAmount)}`);
  await expretry(async () => {
    const receipt = await depositForValidator(depositAmount);
    log.info(`[balcheck] Deposited in ${receipt.transactionHash}`);
  });

  const postDepositStaked = await getValidatorStaked();
  log.debug(`[balcheck] Post staked: ${ethers.utils.formatEther(postDepositStaked)}`);
}

async function processAutomine() {
  try {
    if (c.read_only) {
      log.info(`Read only mode, not automining`);
      return;
    } else {
      const tx = await solver.submitTask(
        c.automine.version,
        wallet.address,
        c.automine.model,
        BigNumber.from(c.automine.fee),
        ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(c.automine.input))),
        {
          gasLimit: 2_500_000,
        }
      );

      const receipt = await tx.wait();
      log.info(`Automine submitTask ${receipt.transactionHash}`);
    }
  } catch (e) {
    log.error(`Automine submitTask failed ${JSON.stringify(e)}`);
  }

  if (c.automine.enabled) {
    await dbQueueJob({
      method: 'automine',
      priority: 5,
      waituntil: now()+c.automine.delay,
      concurrent: false,
      data: {
      },
    });
  }
}

async function processTask(
  taskid: string,
  txid: string,
) {
  try {
    log.info(`Processing task ${taskid}`);
    const {
      model,
      fee,
      owner,
      blocktime,
      version,
      cid: inputCid,
    }= await lookupAndInsertTask(taskid);

    // we are version 0
    if (version !== 0) {
      log.debug(`Task (${taskid}) has version other than 0`);
      // ensure any task mined with non-0 is contested
      // this is looked up when new solutions are seen
      await dbStoreInvalidTask(taskid);
      return;
    }

    const {
      modelEnabled,
      modelTemplate,
      filterPassed,
    } = checkModelFilter(EnabledModels, {
      model,
      now: now(),
      fee,
      blocktime,
      owner,
    });

    if (! modelEnabled) {
      log.debug(`Task (${taskid}) is using non-enabled Model (${model})`);
      return;
    }

    if (! filterPassed) {
      log.debug(`Task (${taskid}) does not pass filter`);
      return;
    }

    // this will be populated
    let input = await lookupAndInsertTaskInput(taskid, inputCid, txid, modelTemplate);
    if (! input) {
      log.debug(`Task (${taskid}) input not found`);
      return;
    }

    log.debug(`Task (${taskid}) input ${JSON.stringify(input, null, 2)}`);

    const m = getModelById(EnabledModels, model);
    if (m === null) {
      log.error(`Task (${taskid}) could not find model (${model})`);
      return;
    }

    const solutionCid = await m.getcid(c, m, taskid, input);
    log.info(`Task (${taskid}) CID (${solutionCid}) generated`);

    if (! solutionCid) {
      log.error(`Task (${taskid}) CID could not be generated`);
      return;
    }
    log.info(`Task (${taskid}) CID (${solutionCid}) generated`);

    const commitment = generateCommitment(wallet.address, taskid, solutionCid);

    try {
      if (c.read_only) {
        log.info(`Read only mode, not signalling commitment for ${taskid}`);
      } else {
        const tx = await arbius.signalCommitment(commitment, {
          gasLimit: 450_000,
        });
        // const receipt = await tx.wait(); // we dont wait here to be faster
        log.info(`Commitment signalled in ${tx.hash}`);
      }
    } catch (e) {
      log.error(`Commitment submission failed ${JSON.stringify(e)}`);
      return;
    }

    // wait a bit to hope commitment is mined
    await sleep(300 + (Math.random() * 200));

    // we will retry in case we didnt wait long enough for commitment
    // if this fails otherwise, it could be because another submitted solution
    await expretry(
      async () => {
        try {
          log.debug(`Submitting solution ${taskid} ${solutionCid}`);
          if (c.read_only) {
            log.info(`Read only mode, not submitting solution for ${taskid}`);
          } else {
            const tx = await solver.submitSolution(taskid, solutionCid, {
              gasLimit: 500_000,
            });
            const receipt = await tx.wait();
            log.info(`Solution submitted in ${receipt.transactionHash}`);
          }

          await dbQueueJob({
            method: "claim",
            priority: 50,
            waituntil: now() + 2000 + 120, // 2 min buffer to avoid time drift claim issues
            concurrent: false,
            data: {
              taskid,
            },
          });
        } catch (e) {
          log.debug(JSON.stringify(e));
          const {
            validator: existingSolutionValidator,
            blocktime: existingSolutionBlocktime,
            claimed: existingSolutionClaimed,
            cid: existingSolutionCid,
          } = await expretry(async () => await arbius.solutions(taskid));

          if (existingSolutionValidator == "0x0000000000000000000000000000000000000000") {
            throw new Error(`An unknown error occurred when tried to submit solution for ${taskid} with cid ${solutionCid} -- ${JSON.stringify(e)}`);
          }

          if (existingSolutionCid === solutionCid) {
            log.info(`Solution found for ${taskid} matches our cid ${solutionCid}`);
            return;
          }

          log.info(`Solution found with cid ${existingSolutionCid} does not match ours ${solutionCid}`);
          await contestSolution(taskid);
        }
      },
      2,
      1.25
    );
  } catch (e) {
    log.error("[processTask] failure", e);
    throw e; // Ensure the caller can handle the thrown error.
  }
}

async function processSolution(taskid: string) {
  try {
    const existing = await dbGetSolution(taskid);
    if (existing) {
      log.debug(`Solution (${taskid}) already in db`);
      return;
    }

    const { owner } = await expretry(async () => await arbius.tasks(taskid));
    log.debug(`Owner of the solution ${owner}`);

    // triggeres to check the transaction for valid CID
    const lookup = (await expretry(() => lookupAndInsertTask(taskid))) as LookupResult;
    if (!lookup) {
      throw new Error("could not look up task -> eventHandlerSolutionSubmitted");
    }
    const { model, cid: inputCid } = lookup;

    const m = getModelById(EnabledModels, model);
    if (!m) {
      log.error(`Task (${taskid}) could not find model (${model}) -> eventHandlerSolutionSubmitted`);
      return;
    }

    // in case we havent already looked up/stored the input
    await lookupAndInsertTaskInput(taskid, inputCid, null, m.template);

    const taskInput = (await dbGetTaskInput(taskid, inputCid)) as TaskInput | null;
    if (!taskInput) {
      log.warn(`Task (${taskid}) input not found in db -> eventHandlerSolutionSubmitted`);
      return;
    }

    const input = JSON.parse(taskInput.data);
    const cid = await m.getcid(c, m, taskid, input);

    const solution = (await expretry(() => arbius.solutions(taskid))) as SolutionDetails;
    if (solution.cid !== cid) {
      log.info(`Solution found with cid ${solution.cid} does not match ours ${cid} -> eventHandlerSolutionSubmitted`);
      await contestSolution(taskid);
    } else {
      log.info(`Solution CID matches our local CID for ${taskid} -> eventHandlerSolutionSubmitted`);
    }

    const { validator, blocktime, claimed, cid: solutionCid } = await expretry(async () => await arbius.solutions(taskid));

    const invalidTask = await dbGetInvalidTask(taskid);
    if (invalidTask != null) {
      await contestSolution(taskid);
    }

    await dbStoreSolution({ taskid, validator, blocktime, claimed, cid: solutionCid });
    return;
  } catch (e) {
    log.error("[processSolution] failure", e);
    throw e;
  }
}

let alreadySeenContestationTask = new Set<string>();
async function processContestation(validator: string, taskid: string) {
  try {
    if (alreadySeenContestationTask.has(taskid)) {
      return;
    }
    alreadySeenContestationTask.add(taskid);

    log.error("processContestation", validator, taskid);
    const canVoteStatus = await expretry(async () => await arbius.validatorCanVote(wallet.address, taskid));
    const canVote = canVoteStatus == 0x0; // success code

    if (! canVote) {
      log.error(`Contestation ${taskid} cannot vote (code ${canVoteStatus})`);
      return;
    }

    const existing = await dbGetContestation(taskid);

    if (existing) {
      log.debug(`Contestation ${taskid} already in db`);
      return;
    }

    // Fetch contestation details (original line had a naming conflict)
    const contestationDetails = await expretry(async () => await arbius.contestations(taskid));

    const lookup = await expretry(async () => await lookupAndInsertTask(taskid));
    if (!lookup) {
      log.error("could not look up task -> eventHandlerContestationSubmitted");
      return;
    }
    const { model, cid: inputCid } = lookup;

    const m = getModelById(EnabledModels, model);

    if (m === null) {
      log.error(`[processContestation] Task (${taskid}) could not find model (${model})`);
      return;
    }

    // in case we havent already looked up/stored the input
    await lookupAndInsertTaskInput(taskid, inputCid, null, m.template);

    const invalidTask = await dbGetInvalidTask(taskid);
    if (invalidTask != null) {
      log.info(`Contested task ${taskid} has invalid input. Voting in favor.`);
      await voteOnContestation(taskid, true);
    } else {
      const taskInput = await dbGetTaskInput(taskid, inputCid);

      if (!taskInput) {
        log.error(`[processContestation] Task (${taskid}) input not found in db`);
        return;
      }
      const input = JSON.parse(taskInput.data);
      const expectedCid = await m.getcid(c, m, taskid, input);
      log.error(`input: ${taskInput.data}`);
      log.error(`Expected CID: ${expectedCid}`);

      // Fetch contested solution details
      const solution = await expretry(async () => await arbius.solutions(taskid));

      // Compare CIDs and decide on voting
      if (solution.cid !== expectedCid) {
        log.info(`[processContestation] Contested CID does not match expected CID for ${taskid}. Voting true`);
        await voteOnContestation(taskid, true);
      } else {
        log.info(`[processContestation] Contested CID matches expected CID for ${taskid}. Voting false.`);
        await voteOnContestation(taskid, false);
      }

      // Store contestation details in db
      await dbStoreContestation({
        taskid,
        validator: contestationDetails.validator,
        blocktime: contestationDetails.blocktime,
        finish_start_index: contestationDetails.finish_start_index,
      });
    }
  } catch (e) {
    log.error("[processContestation] failure", e);
    throw e;
  }
}

async function contestSolution(taskid: string) {
  try {
    log.info(`Attempt to contest ${taskid} solution`);

    const validatorStake = await getValidatorStaked();
    const validatorMinimum = await expretry(async () => await arbius.getValidatorMinimum());
    if (validatorStake.lt(validatorMinimum.mul(110).div(100))) {
      log.info("Validator stake is less than 110% of minimum, not contesting");
      return;
    }

    const { validator } = await expretry(async () => await arbius.solutions(taskid));
    log.debug(`contestSolution ${taskid} from ${validator}`);

    if (validator === wallet.address) {
      log.error(`Attempting to contest own solution ${taskid}  --- lets not do this`);
      log.error(`Please report this to the developers`);
      return;
    }

    if (c.read_only) {
      log.info(`Read only mode, not contesting ${taskid}`);
    } else {
      const tx = await solver.submitContestation(taskid);
      const receipt = await tx.wait();
      log.info(`Submitted contestation for ${taskid} in ${receipt.transactionHash}`);
      alreadySeenContestationTask.add(taskid);
      alreadySeenContestationVote.add(taskid);
    }
    await dbQueueJob({
      method: 'contestationVoteFinish',
      priority: 200,
      waituntil: now()+5010,
      concurrent: false,
      data: {
        taskid,
      },
    });
  } catch (e) {
    log.debug(JSON.stringify(e));
    // check if someone else submitted a contestation
    const {
      validator: existingContestationValidator,
      blocktime: existingContestationBlocktime,
    } = await expretry(async () => await arbius.contestations(taskid));

    // someone else contested first
    if (existingContestationValidator == "0x0000000000000000000000000000000000000000") {
      log.error(`An unknown error occurred when we tried to contest ${taskid}`);
      return;
    }

    log.info(`Contestation for ${taskid} was already created by ${existingContestationValidator}`);
    // if we are contesting it, then we agree it is invalid
    await voteOnContestation(taskid, true);
  }
}

let alreadySeenContestationVote = new Set<string>();
async function voteOnContestation(taskid: string, yea: boolean) {
  if (alreadySeenContestationVote.has(taskid)) {
    return;
  }
  alreadySeenContestationVote.add(taskid);
  const canVoteStatus = await expretry(async () => await arbius.validatorCanVote(wallet.address, taskid));
  const canVote = canVoteStatus == 0x0; // success code

  if (! canVote) {
    log.debug(`[voteOnContestation] Contestation ${taskid} cannot vote (code ${canVoteStatus})`);
    return;
  }

  const validatorStake = await getValidatorStaked();
  const validatorMinimum = await expretry(async () => await arbius.getValidatorMinimum());
  if (validatorStake.lt(validatorMinimum.mul(110).div(100))) {
    log.info("Validator stake is less than 110% of minimum, not voting");
    return;
  }

  try {
    if (c.read_only) {
      log.info(`Read only mode, not voting ${yea ? 'YES' : 'NO'} on contestation ${taskid}`);
    } else {
      log.info(`Attempt to vote ${yea ? 'YES' : 'NO'} on ${taskid} contestation`);
      const tx = await solver.voteOnContestation(taskid, yea);
      const receipt = await tx.wait();
      log.info(`Contestation vote ${yea ? 'YES' : 'NO'} submitted on ${taskid} in ${receipt.transactionHash}`);
    }
  } catch (e) {
    log.debug(JSON.stringify(e));
    log.error(`Failed voting on contestation ${taskid}`);
  }
}

async function processClaim(taskid: string) {
  try {
    const receipt = await expretry(async () => {
      const { claimed } = await expretry(async () => await arbius.solutions(taskid));
      log.debug("processClaim [claimed]", claimed);
      if (claimed) {
        log.warn(`Solution (${taskid}) already claimed`);
        return null;
      }

      const { validator: contestationValidator } = await expretry(async () => await arbius.contestations(taskid));
      log.debug("processClaim [contestationValidator]", contestationValidator);
      if (contestationValidator != "0x0000000000000000000000000000000000000000") {
        log.error(`Contestation found for solution ${taskid}, cannot claim`);

        await dbQueueJob({
          method: 'contestationVoteFinish',
          priority: 200,
          waituntil: now()+5010,
          concurrent: false,
          data: {
            taskid,
          },
        });

        return null;
      }

      if (c.read_only) {
        log.info(`Read only mode, not claiming ${taskid}`);
        return null;
      } else {
        const tx = await arbius.claimSolution(taskid, {
          gasLimit: 300_000,
        });
        const receipt = await tx.wait()
        log.info(`Claim ${taskid} in ${receipt.transactionHash}`);
        return receipt;
      }
    }, 2, 1.25);

    if (receipt == null) {
      log.error(`Failed claiming (${taskid})`);
      return;
    }

    log.debug(`Solution (${taskid}) claimed`);
  } catch (e) {
    log.error("[processClaim] failure", e);
    throw e;
  }
}

async function processGarbageCollect() {
  let timer = +new Date();
  log.debug(`GarbageCollect running`);
  await dbGarbageCollect();
  log.debug(`GarbageCollect finished in ${+new Date() - timer}ms`);

  dbQueueJob({
    method: 'garbageCollect',
    priority: 1000,
    waituntil: now()+60,
    concurrent: false,
    data: {
    },
  });
}

async function mlStrategyReplicate(
  model: Model,
  taskid: string,
  input: any,
  outputTransform: (output: any) => Promise<string[]>, // paths
): Promise<string[]> {
  log.debug(`Replicate for Task (${taskid}) with input ${JSON.stringify(input)}`);
  // this looks like:
  // https://r8.im/ORG/TITLE@sha256:H
  // we want:
  // ORG/TITLE:H
  const modelKey = model.template.meta.docker
    .replace('https://r8.im/', '')
    .replace('@sha256', '');

  log.debug(`Replicate running for Task (${taskid}) Model (${model.template.meta.title}) ${JSON.stringify(input)}`);

  const output = await expretry(async () => await replicate.run(modelKey, {
    input
  }), 5) as string[];
  log.debug(`Replicate output for Task (${taskid}) ${JSON.stringify(output)}`);

  if (! output || output.length < 1) {
    throw Error('output length too small');
  }

  return outputTransform(output!);
}


export async function processJobs(jobs: DBJob[]) {
  function assembleFn(job: DBJob): () => Promise<void> {

    let decoded = {taskid: '', txid: '', validator:"",input:""}
    try {
     decoded = JSON.parse(job.data);
    }catch(err){

    }
    switch (job.method) {
      case 'automine':
        return () => processAutomine();
      case 'validatorStake':
        return () => processValidatorStake();
      case 'task':
        return () => processTask(
          decoded.taskid,
          decoded.txid,
        );
      case 'solution':
        return () => processSolution(decoded.taskid);
      case 'claim':
        return () => processClaim(decoded.taskid);
        break;
      case 'garbageCollect':
        return () => processGarbageCollect();
        break;
      /*
      case 'pinGovernanceProposal':
        return () => processPinGovernanceProposal(
          decoded.proposalId,
          decoded.description,
        );
      */
      case 'pinTaskInput':
        return () => processPinTaskInput(
          decoded.taskid,
          decoded.input,
        );
        break;
      case 'contestation':
        return () => processContestation(decoded.validator, decoded.taskid);
        break;
      case 'contestationVoteFinish':
        return () => processContestationVoteFinish(decoded.taskid);
        break;

      default:
        log.error(`Job (${job.id}) method (${job.method}) has no implementation`);
        process.exit(1);
    }
  }

  // returns if job processed
  async function loop(
    job: DBJob,
    concurrent: boolean,
  ): Promise<boolean> {
    if (job.concurrent != concurrent) {
      return false;
    }

    if (job.waituntil > now()) {
      return false;
    }

    log.debug(`Job (${job.id}) [${job.method}] processing`);

    const f = assembleFn(job)()
    .catch(async (e) => {
      await dbStoreFailedJob(job);
    });

    if (! concurrent) {
      await f;
    }

    log.debug(`Job (${job.id}) [${job.method}] processed`);
    await dbDeleteJob(job.id);
    return true;
  }

  // log.debug(jobs)

  // first process all concurrent jobs
  for (const job of jobs) {
    loop(job, true);
  }

  // process all non-concurrent
  for (const job of jobs) {
    const processed = await loop(job, false);
    // only process one non-concurrent job at a time
    if (processed) {
      return;
    }
  }
}

async function versionCheck() {
  const arbiusVersion = await arbius.version();
  if (arbiusVersion.lte(minerVersion)) {
    log.info(`Arbius version (${arbiusVersion}) fits miner version (${minerVersion})`);
  } else {
    log.error(`version mismatch, have miner version ${minerVersion.toString()} and arbius is ${arbiusVersion.toString()} - upgrade your miner`);
    process.exit(1);
  }
}

export async function main() {
  // need extra for ethers
  log.debug("Setting max file listeners to 100 for ethers");
  process.setMaxListeners(100);

  // we dont care about old ones
  log.debug("Clearing old automatically added retry jobs");
  dbClearJobsByMethod('validatorStake');
  dbClearJobsByMethod('automine');
  dbClearJobsByMethod("task");
  dbClearJobsByMethod("garbageCollect");

  log.debug("Bootup check");
  await versionCheck();
  if (c.evilmode) {
    for (let i=0; i<20; ++i) {
      log.warn('YOU HAVE EVIL MODE ENABLED, YOU WILL BE SLASHED');
      log.warn('KILL YOUR MINER IMMEDIATELY IF NOT ON TESTNET');
    }
  } else {
  
    const m = getModelById(EnabledModels, Config.models.kandinsky2.id);
    if (m === null) {
      process.exit(1);
      return;
    }
    
    const input = {prompt: "arbius test cat", seed: 1337};
    const taskid = 'startup-test-taskid';
  
    const cid = await m.getcid(c, m, taskid, input);
  
    const expected = '0x12201bdab4164320cc8621282982c55eb76e14427aa5793278b37b6108f63fb5d577';
    if (cid === expected) {
      log.info(`Model (${Config.models.kandinsky2.id}) CID (${cid}) matches expected CID (${expected})`);
    } else {
      log.error(`Model (${Config.models.kandinsky2.id}) CID (${cid}) does not match expected CID (${expected})`);
      log.info(`If you are running a100 this is a bug, please report with system details at https://github.com/semperai/arbius`);
      log.info(`Join our telegram https://t.me/arbius_ai`);
      process.exit(1);
    }
  }


  await dbQueueJob({
    method: 'validatorStake',
    priority: 1000,
    waituntil: 0,
    concurrent: false,
    data: {},
  });

  await dbQueueJob({
    method: 'garbageCollect',
    priority: 1000,
    waituntil: now(),
    concurrent: false,
    data: {},
  });

  if (c.automine.enabled) {
    await dbQueueJob({
      method: 'automine',
      priority: 5,
      waituntil: 0,
      concurrent: false,
      data: {
      },
    });
  }

  arbius.on('VersionChanged', async(
    version: ethers.BigNumber,
    evt:     ethers.Event,
  ) => {
    log.debug('Event.VersionChanged', version.toString());
    await versionCheck();
  });

  arbius.on('TaskSubmitted', (
    taskid:  string,
    modelid: string,
    fee:     BigNumber,
    sender:  string,
    evt:     ethers.Event,
  ) => eventHandlerTaskSubmitted(taskid, evt));

  arbius.on('TaskRetracted', (
    taskid:  string,
    evt:     ethers.Event,
  ) => eventHandlerTaskRetracted(taskid, evt));

  arbius.on('SolutionSubmitted', (
    validator: string,
    taskid:    string,
    evt:       ethers.Event,
  ) => eventHandlerSolutionSubmitted(taskid, evt));

  arbius.on('ContestationSubmitted', (
    validator: string,
    taskid:    string,
    evt:       ethers.Event,
  ) => eventHandlerContestationSubmitted(validator, taskid, evt));

  arbius.on('ContestationVote', (
    validator: string,
    taskid:    string,
    yea:       boolean,
    evt:       ethers.Event,
  ) => eventHandlerContestationVote(validator, taskid, yea, evt));

  /*
  governor.on('ProposalCreated', (
    proposalId:  string,
    proposer:    string,
    targets:     string,
    values:      string,
    signatures:  string,
    calldatas:   string,
    voteStart:   BigNumber,
    voteEnd:     BigNumber,
    description: string,
    evt:         ethers.Event,
  ) => eventHandlerGovernanceProposalCreated(proposalId, evt));
  */

  // job processor / main loop
  while (true) {
    const jobs = await dbGetJobs();
    if (jobs.length === 0) {
      await sleep(100);
      continue;
    }

    let hasActiveJobs = false;
    for (const job of jobs) {
      if (job.waituntil < now()) {
        hasActiveJobs = true;
        break;
      }
    }

    if (! hasActiveJobs) {
      await sleep(100);
      continue;
    }

    log.debug(`Job queue has ${jobs.length} jobs`);
    // log.debug(jobs);
    await processJobs(jobs);
  }
}
