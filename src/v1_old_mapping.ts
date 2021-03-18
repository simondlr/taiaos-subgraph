import { BigInt, store, log, Address, ByteArray } from "@graphprotocol/graph-ts"
import { LogBuy, LogCollection, LogForeclosure, LogPriceChange, STEWARDV1 as STEWARD } from '../generated/STEWARDV1/STEWARDV1'
import { Transfer } from '../generated/ARTWORKV1/ERC721V1'
import { Patron, Steward, PatronSteward } from '../generated/schema'

export function getSteward(stewardAddress: string): Steward {
  // oldv1 is merged into restored v1
  if(stewardAddress == "0x74e6ab057f8a9fd9355398a17579cd4c90ab2b66") {
    stewardAddress = "0xb602c0bbfab973422b91c8dfc8302b7b47550fc0";
  }

  let steward = Steward.load(stewardAddress);

  if (steward == null) {
    log.info('Null Steward. Creating {}', [stewardAddress]);
    steward = new Steward(stewardAddress);
    //previous patron is only used in case of foreclosure
    steward.previousPatron = stewardAddress; // on mint, 'previous patron' is just the same
    steward.currentPatron = stewardAddress; // on mint, the steward is the first patron
    steward.currentDeposit = new BigInt(0);
    steward.currentPrice = new BigInt(0);
    steward.timeAcquired = new BigInt(0);
    steward.timeLastCollected = new BigInt(0);
    steward.totalCollected = new BigInt(0);
    steward.foreclosureTime = new BigInt(0);
  }

  return steward as Steward 
}

export function getPatron(patronAddress: string): Patron {
  let patron = Patron.load(patronAddress);

  if (patron == null) {
    log.info('Null Patron. Creating {}', [patronAddress]);
    patron = new Patron(patronAddress);
  }

  return patron as Patron
}

export function getPatronSteward(patron: string, steward: string): PatronSteward {
  // oldv1 is merged into restored v1
  if(steward == "0x74e6ab057f8a9fd9355398a17579cd4c90ab2b66") {
    steward = "0xb602c0bbfab973422b91c8dfc8302b7b47550fc0";
  }

  let psID = patron + steward;
  let ps = PatronSteward.load(psID);

  if (ps == null ) {
    log.info('Null PatronSteward. Creating {}', [psID]);
    ps = new PatronSteward(psID);
    ps.patron = patron;
    ps.steward = steward;
    ps.timeHeld = new BigInt(0);
    ps.collected = new BigInt(0);
  }

  return ps as PatronSteward;
}

function updateTimeHeldAndDeposit(steward: Steward, ps: PatronSteward, onchainSteward: STEWARD): void {
  //NOTE: reason why steward vs event address is different
  // is that the on-chain call for oldv1 will be different to where it is stored, which stewardAddress
  let deposit = onchainSteward.deposit();
  // let foreclosureTime = onchainSteward.foreclosureTime();

  //timeHeld[_currentOwner] = timeHeld[_currentOwner].add((timeLastCollected.sub(timeAcquired)));
  //NOTE: in the contract, this is only updated upon transfer, not on collection
  //for subgraph, it's done manually upon each collection.
  // timeHeld = timeHeld + (time recently collected - previous time collected)
  let pTLC = steward.timeLastCollected;
  let onTLC = onchainSteward.timeLastCollected();
  let newTimeHeld = ps.timeHeld.plus(onTLC.minus(pTLC));

  // set vars
  ps.timeHeld = newTimeHeld;
  steward.timeLastCollected = onTLC;
  steward.currentDeposit = deposit;
  // steward.foreclosureTime = foreclosureTime;

  log.info('Collection: s {}, pTLC {}, onTLC {}, newTH {}', [
    steward.id.toString(),
    pTLC.toString(),
    onTLC.toString(),
    newTimeHeld.toString(),
  ])
}

// event LogCollection(uint256 indexed collected);
export function handleCollection(event: LogCollection): void {
  // happens on collectpatronage 
  let stewardAddress = event.address.toHexString();

  let limitBlock = BigInt.fromI32(11817708);

  log.info("ev: {}", [event.block.number.toString()]);

  // restoration occurred on 11817708.
  if(stewardAddress == "0x74e6ab057f8a9fd9355398a17579cd4c90ab2b66" && event.block.number.gt(limitBlock)) {
    log.info("not firing collection. block number is {}", [event.block.number.toString()]);
    // don't parse since this is *AFTER* restoration
  } else {
    let steward = getSteward(stewardAddress);
    let onchainSteward = STEWARD.bind(event.address);
    let ps: PatronSteward;

    if(steward.currentPrice != new BigInt(0)) { // update timeHeld if it's normal collection
      ps = getPatronSteward(steward.currentPatron, steward.id);
    } else { 
      // after foreclosure, the collection firing should update the previous patron
      ps = getPatronSteward(steward.previousPatron, steward.id);
    }

    updateTimeHeldAndDeposit(steward, ps, onchainSteward);
    ps.collected = ps.collected.plus(event.params.collected);
    steward.totalCollected = steward.totalCollected.plus(event.params.collected);

    steward.save();
    ps.save();
  }
}

// happens after log collection
// price can't be changed in old V1 thus don't need to check for it.
export function handlePriceChange(event: LogPriceChange): void {
  // steward changes
  let steward = getSteward(event.address.toHexString());

  steward.currentPrice = event.params.newPrice;
  steward.save();
}

// event LogBuy(address indexed owner, uint256 indexed price);
// no one can buy old V1 thus don't need to check for it.
export function handleBuy(event: LogBuy): void {

  let steward = getSteward(event.address.toHexString());
  let patron =  getPatron(event.params.owner.toHexString());
  let onchainSteward = STEWARD.bind(event.address);

  // steward changes
  steward.currentPrice = event.params.price;

  steward.currentPatron = event.params.owner.toHexString();
  steward.timeAcquired = event.block.timestamp;
  steward.timeLastCollected = event.block.timestamp; // usually collection will log this, but if it is sold from zero, it needs to be reset
  // do a manual call to deposit()
  steward.currentDeposit = onchainSteward.deposit();

  // different ps
  let ps = getPatronSteward(event.params.owner.toHexString(), event.address.toHexString());

  patron.save();
  steward.save();
  ps.save();
}

// event LogForeclosure(address indexed prevOwner);
export function handleForeclosure(event: LogForeclosure): void {
  // anti-mint basically
  let steward = getSteward(event.address.toHexString());
  steward.currentPrice = new BigInt(0);
  // current deposit is changed to zero in handlecollection that comes after foreclosure

  steward.save();
}

export function handleMint(event: Transfer): void {

  log.info('Transfer event fired for ERC721 {}',[event.address.toHexString()]);
  //mapping of steward >< patron
  // oldv1 ERC721: 0x6d7c26f2e77d0ccc200464c8b2040c0b840b28a2
  // oldv1 Steward: 0x74e6ab057f8a9fd9355398a17579cd4c90ab2b66
  // changed to -> 
  let stewardAddress = "0xb602c0bbfab973422b91c8dfc8302b7b47550fc0"; // merged object between old + restored v1.

  // using initial mint as to create entities vs logforeclosure because v1_old doesn't do initial logforeclosure
  let from = event.params.from.toHexString();

  // create if it's being minted.
  if(from == "0x0000000000000000000000000000000000000000") {
    log.info('Minting happened to: {}', [event.params.to.toHexString()]);
    // mint event
    let steward = getSteward(stewardAddress); 

    // on mint, set's to timestamp
    // won't use on-chain call, but rather manually create in graph
    steward.timeLastCollected = event.block.timestamp;

    // the stewards themselves as 'patrons' (holding it when foreclosed)
    let patron = getPatron(stewardAddress);

    // patron + steward
    let patronSteward = getPatronSteward(stewardAddress, stewardAddress);

    steward.save();
    patron.save();
    patronSteward.save();
  } 

  // it was a foreclosure event, so set previous patron
  if(event.params.to.toHexString() == "0x74e6ab057f8a9fd9355398a17579cd4c90ab2b66") {
    let steward = getSteward(stewardAddress); // set currentPatron to stewardAddress
    steward.previousPatron = event.params.from.toHexString();
    steward.save();
  }
}