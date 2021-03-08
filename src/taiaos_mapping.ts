import { BigInt, store, log, Address, ByteArray } from "@graphprotocol/graph-ts"
import { LogBuy, LogCollection, LogForeclosure, LogPriceChange, STEWARD_V2 } from '../generated/STEWARD_V1_RESTORED/STEWARD_V2'
import { Transfer } from '../generated/ARTWORK_V1_RESTORED/ERC721'
import { Patron, Steward, PatronSteward } from '../generated/schema'

export function getSteward(stewardAddress: string): Steward {
  let steward = Steward.load(stewardAddress);

  if (steward == null) {
    steward = new Steward(stewardAddress);
    steward.currentPatron = stewardAddress; // on mint, the steward is the first patron
    steward.currentDeposit = new BigInt(0);
    steward.timeLastCollected = new BigInt(0);
  }

  return steward as Steward 
}

export function getPatron(patronAddress: string): Patron {
  let patron = Patron.load(patronAddress);

  if (patron == null) {
    patron = new Patron(patronAddress);
  }

  return patron as Patron
}

export function getPatronSteward(patron: string, steward: string): PatronSteward {
  let psID = patron + steward;
  let ps = PatronSteward.load(psID);

  if (ps == null ) {
    ps = new PatronSteward(psID);
    ps.patron = patron;
    ps.steward = steward;
    ps.timeHeld = new BigInt(0);
    ps.collected = new BigInt(0);
  }

  return ps as PatronSteward;
}

// event LogCollection(uint256 indexed collected);
export function handleCollect(event: LogCollection): void {
  // happens on collectpatronage 
  // do a manual call to deposit()
  let stewardAddress = event.address.toHexString(); // which steward did a collection?
  
  let steward = getSteward(stewardAddress);
  let currentPatronAddress = steward.currentPatron;

  let onchainSteward = STEWARD_V2.bind(event.address);
  let deposit = onchainSteward.deposit();

  let ps = getPatronSteward(currentPatronAddress, stewardAddress);

  // set vars
  ps.collected = ps.collected.plus(event.params.collected);
  // time held needs to be a manual call due to the fact that in some instances the foreclosure happened in the past (before tx execution)
  ps.timeHeld = onchainSteward.timeHeld(Address.fromString(currentPatronAddress.toString()));

  steward.currentDeposit = deposit;
  steward.timeLastCollected = event.block.timestamp;

  steward.save();
  ps.save();
}

// happens after log collection
export function handlePriceChange(event: LogPriceChange): void {
  // steward changes
  let steward = getSteward(event.address.toHexString());

  steward.currentPrice = event.params.newPrice;
  steward.save();
}

// event LogBuy(address indexed owner, uint256 indexed price);
export function handleBuy(event: LogBuy): void {

  let steward = getSteward(event.address.toHexString());
  let onchainSteward = STEWARD_V2.bind(event.address);
  // steward changes

  // do a manual call to deposit()
  steward.currentPrice = event.params.price;
  steward.currentPatron = event.params.owner.toHexString();
  steward.timeAcquired = event.block.timestamp;
  steward.currentDeposit = onchainSteward.deposit();

  // different ps
  let ps = getPatronSteward(event.params.owner.toHexString(), event.address.toHexString());

  steward.save();
  ps.save();
}

export function handleForeclosure(event: LogForeclosure): void {
  // anti-mint basically
  let steward = getSteward(event.address.toHexString());
  let onchainSteward = STEWARD_V2.bind(event.address);

  let previousPS = getPatronSteward(event.params.prevOwner.toHexString(), event.address.toHexString());
  previousPS.timeHeld = onchainSteward.timeHeld(Address.fromString(previousPS.patron.toString())); // update final time held

  // change current patron to steward itself
  steward.currentPatron = event.address.toHexString();
  // note: don't need invoke PS here, since it would've been created before + have nothing new to add

  previousPS.save();
  steward.save();
}

export function handleMint(event: Transfer): void {

  // using initial mint as to create entities vs logforeclosure because v1_old doesn't do initial logforeclosure
  const from = event.params.from.toHexString();

  if(from == "0x0000000000000000000000000000000000000000") {
    // mint event
    // will only fire 3 times
    let steward = getSteward(event.params.to.toHexString()); // first transfer in all 3 editions are to respective stewards

    // on mint, set's to timestamp
    // won't use on-chain call, but rather manually create in graph
    steward.timeLastCollected = event.block.timestamp; 

    // the stewards themselves as 'patrons' (holding it when foreclosed)
    let patron = getPatron(event.params.to.toHexString());

    // patron + steward
    let patronSteward = getPatronSteward(event.params.to.toHexString(), event.params.to.toHexString());

    steward.save();
    patron.save();
    patronSteward.save();
  }
}