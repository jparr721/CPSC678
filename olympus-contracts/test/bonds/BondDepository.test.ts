import { ethers, network } from "hardhat";
import { expect } from "chai";
import { FakeContract, MockContract, MockContractFactory, smock } from "@defi-wonderland/smock";
import { MockERC20, OlympusBondDepositoryV2 } from "../../types";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { Contract, ContractFactory } from "ethers";
import { bne } from "../utils/scripts";

describe("Bond Depository", async () => {
    const LARGE_APPROVAL = "100000000000000000000000000000000";
    // Initial mint for Frax, OHM and DAI (10,000,000)
    const initialMint = "10000000000000000000000000";
    const initialDeposit = "1000000000000000000000000";

    // Increase timestamp by amount determined by `offset`

    let deployer: SignerWithAddress;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let carol: SignerWithAddress;
    let erc20Factory: MockContractFactory<ContractFactory>;
    let authFactory;
    let gOhmFactory;
    let depositoryFactory;

    let auth: MockContract<Contract>;
    let dai: MockContract<Contract>;
    let ohm: MockContract<Contract>;
    let depository: OlympusBondDepositoryV2;

    let treasury: FakeContract;
    let gOHM: FakeContract;
    let staking: FakeContract;

    let capacity = 10000e9;
    const initialPrice = 400e9;
    const buffer = 2e5;

    const vesting = 100;
    const timeToConclusion = 60 * 60 * 24;
    let conclusion;

    const depositInterval = 60 * 60 * 4;
    const tuneInterval = 60 * 60;

    const refReward = 10;
    const daoReward = 50;

    const bid = 0;

    /**
     * Everything in this block is only run once before all tests.
     * This is the home for setup methods
     */
    before(async () => {
        [deployer, alice, bob, carol] = await ethers.getSigners();

        authFactory = await ethers.getContractFactory("OlympusAuthority");
        erc20Factory = await smock.mock("MockERC20");
        gOhmFactory = await smock.mock("MockGOhm");

        depositoryFactory = await ethers.getContractFactory("OlympusBondDepositoryV2");

        const block = await ethers.provider.getBlock("latest");
        conclusion = block.timestamp + timeToConclusion;
    });

    beforeEach(async () => {
        dai = await erc20Factory.deploy("Dai", "DAI", 18);

        auth = await authFactory.deploy(
            deployer.address,
            deployer.address,
            deployer.address,
            deployer.address
        );
        ohm = await erc20Factory.deploy("Olympus", "OHM", 9);
        treasury = await smock.fake("ITreasury");
        gOHM = await gOhmFactory.deploy("50000000000"); // Set index as 50
        staking = await smock.fake("OlympusStaking");
        depository = await depositoryFactory.deploy(
            auth.address,
            ohm.address,
            gOHM.address,
            staking.address,
            treasury.address
        );

        // Setup for each component
        await dai.mint(bob.address, initialMint);

        // To get past OHM contract guards
        await auth.pushVault(treasury.address, true);

        await dai.mint(deployer.address, initialDeposit);
        await dai.approve(treasury.address, initialDeposit);

        // await treasury.deposit(initialDeposit, carol.address, "10000000000000");

        // await ohm.mint(deployer.address, "10000000000000");
        await ohm.mint(deployer.address, "1000");
        await treasury.baseSupply.returns(await ohm.totalSupply());

        // Mint enough gOHM to payout rewards
        await gOHM.mint(depository.address, "1000000000000000000000");

        await ohm.connect(alice).approve(depository.address, LARGE_APPROVAL);
        await dai.connect(bob).approve(depository.address, LARGE_APPROVAL);

        await depository.setRewards(refReward, daoReward);
        await depository.whitelist(carol.address);

        await dai.connect(alice).approve(depository.address, capacity);

        // create the first bond
        await depository.create(
            dai.address,
            [capacity, initialPrice, buffer],
            [false, true],
            [vesting, conclusion],
            [depositInterval, tuneInterval]
        );
    });

    const increaseTime = async (amount_seconds: Number): Promise<void> => { await network.provider.send("evm_increaseTime", [amount_seconds]); }

    it("should create market", async () => {
        expect(await depository.isLive(bid)).to.equal(true);
    });

    it("should conclude in correct amount of time", async () => {
        const [, , , concludes] = await depository.terms(bid);
        expect(concludes).to.equal(conclusion);
        const [, , length, , , ,] = await depository.metadata(bid);
        // timestamps are a bit inaccurate with tests
        const upperBound = timeToConclusion * 1.0033;
        const lowerBound = timeToConclusion * 0.9967;
        expect(Number(length)).to.be.greaterThan(lowerBound);
        expect(Number(length)).to.be.lessThan(upperBound);
    });

    it("should set max payout to correct % of capacity", async () => {
        const [, , , , maxPayout, ,] = await depository.markets(bid);
        const upperBound = (capacity * 1.0033) / 6;
        const lowerBound = (capacity * 0.9967) / 6;
        expect(Number(maxPayout)).to.be.greaterThan(lowerBound);
        expect(Number(maxPayout)).to.be.lessThan(upperBound);
    });

    it("should return IDs of all markets", async () => {
        // create a second bond
        await depository.create(
            dai.address,
            [capacity, initialPrice, buffer],
            [false, true],
            [vesting, conclusion],
            [depositInterval, tuneInterval]
        );
        const [first, second] = await depository.liveMarkets();
        expect(Number(first)).to.equal(0);
        expect(Number(second)).to.equal(1);
    });

    it("should update IDs of markets", async () => {
        // create a second bond
        await depository.create(
            dai.address,
            [capacity, initialPrice, buffer],
            [false, true],
            [vesting, conclusion],
            [depositInterval, tuneInterval]
        );
        // close the first bond
        await depository.close(0);
        const [first] = await depository.liveMarkets();
        expect(Number(first)).to.equal(1);
    });

    it("should include ID in live markets for quote token", async () => {
        const [id] = await depository.liveMarketsFor(dai.address);
        expect(Number(id)).to.equal(bid);
    });

    it("should start with price at initial price", async () => {
        const lowerBound = initialPrice * 0.9999;
        expect(Number(await depository.marketPrice(bid))).to.be.greaterThan(lowerBound);
    });

    it("should give accurate payout for price", async () => {
        const price = await depository.marketPrice(bid);
        const amount = "10000000000000000000000"; // 10,000
        const expectedPayout = (amount as any) / (price as any);
        const lowerBound = expectedPayout * 0.9999;
        expect(Number(await depository.payoutFor(amount, 0))).to.be.greaterThan(lowerBound);
    });

    it("should decay debt", async () => {
        const [, , , totalDebt, , ,] = await depository.markets(0);

        // await network.provider.send("evm_increaseTime", [100]);
        await increaseTime(100);
        await depository.connect(bob).deposit(bid, "0", initialPrice, bob.address, carol.address);

        const [, , , newTotalDebt, , ,] = await depository.markets(0);
        expect(Number(totalDebt)).to.be.greaterThan(Number(newTotalDebt));
    });

    it("should not start adjustment if ahead of schedule", async () => {
        const amount = "650000000000000000000000"; // 10,000
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice * 2, bob.address, carol.address);
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice * 2, bob.address, carol.address);

        await network.provider.send("evm_increaseTime", [tuneInterval]);
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice * 2, bob.address, carol.address);
        const [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);
        expect(Boolean(active)).to.equal(false);
    });

    it("should start adjustment if behind schedule", async () => {
        await network.provider.send("evm_increaseTime", [tuneInterval]);
        const amount = "10000000000000000000000"; // 10,000
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);
        const [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);
        expect(Boolean(active)).to.equal(true);
    });

    it("adjustment should lower control variable by change in tune interval if behind", async () => {
        await network.provider.send("evm_increaseTime", [tuneInterval]);
        const [, controlVariable, , ,] = await depository.terms(bid);
        const amount = "10000000000000000000000"; // 10,000
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);
        await network.provider.send("evm_increaseTime", [tuneInterval]);
        const [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);
        const [, newControlVariable, , ,] = await depository.terms(bid);
        expect(newControlVariable).to.equal(controlVariable.sub(change));
    });

    it("adjustment should lower control variable by half of change in half of a tune interval", async () => {
        await network.provider.send("evm_increaseTime", [tuneInterval]);
        const [, controlVariable, , ,] = await depository.terms(bid);
        const amount = "10000000000000000000000"; // 10,000
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);
        const [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);
        await network.provider.send("evm_increaseTime", [tuneInterval / 2]);
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);
        const [, newControlVariable, , ,] = await depository.terms(bid);
        const lowerBound = ((controlVariable as any) - (change as any) / 2) * 0.999;
        expect(Number(newControlVariable)).to.lessThanOrEqual(
            Number(controlVariable.sub(change.div(2)))
        );
        expect(Number(newControlVariable)).to.greaterThan(Number(lowerBound));
    });

    it("adjustment should continue lowering over multiple deposits in same tune interval", async () => {
        await network.provider.send("evm_increaseTime", [tuneInterval]);
        const [, controlVariable, , ,] = await depository.terms(bid);
        const amount = "10000000000000000000000"; // 10,000
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);
        const [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);

        await network.provider.send("evm_increaseTime", [tuneInterval / 2]);
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);

        await network.provider.send("evm_increaseTime", [tuneInterval / 2]);
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);
        const [, newControlVariable, , ,] = await depository.terms(bid);
        expect(newControlVariable).to.equal(controlVariable.sub(change));
    });

    it("should not redeem before vested", async () => {
        const balance = await ohm.balanceOf(bob.address);
        const amount = "10000000000000000000000"; // 10,000
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);
        await depository.connect(bob).redeemAll(bob.address, true);
        expect(await ohm.balanceOf(bob.address)).to.equal(balance);
    });

    it("should redeem after vested", async () => {
        const amount = "10000000000000000000000"; // 10,000
        const [expectedPayout, expiry, index] = await depository
            .connect(bob)
            .callStatic.deposit(bid, amount, initialPrice, bob.address, carol.address);

        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);

        await network.provider.send("evm_increaseTime", [1000]);
        await depository.redeemAll(bob.address, true);

        const bobBalance = Number(await gOHM.balanceOf(bob.address));
        expect(bobBalance).to.greaterThanOrEqual(Number(await gOHM.balanceTo(expectedPayout)));
        expect(bobBalance).to.lessThan(Number(await gOHM.balanceTo((expectedPayout as any) * 1.0001)));
    });

    it.only("should give correct rewards to referrer and dao", async () => {
        const daoBalance = await ohm.balanceOf(deployer.address);
        console.log("daoBalance", daoBalance);

        const [, , , totalDebt, , ,] = await depository.markets(0);
        console.log("CURRENT DEBT", totalDebt);

        const carolsCurrentBalance = await ohm.balanceOf(carol.address);

        const amount = "1000000000000000"; // 10,000

        const [payout, expiry, index] = await depository
            .connect(bob)
            .callStatic.deposit(bid, amount, initialPrice, bob.address, carol.address);

        console.log("initialPrice", initialPrice);
        console.log("payout", payout);

        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);

        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);

        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice, bob.address, carol.address);

        increaseTime(1000000);

        // Mint ohm for depository to payout reward
        await ohm.mint(depository.address, amount);

        const daoExpected = Number(daoBalance) + Number((Number(payout) * daoReward) / 1e4);
        await depository.getReward();

        const frontendReward = Number(await ohm.balanceOf(deployer.address));
        console.log("frontendReward", frontendReward);

        // Re-map the award amount into sane number ranges
        const refExpected =
            Number(carolsCurrentBalance) + Number((Number(payout) * refReward) / 1e4);
        console.log("refExpected", refExpected);

        // Connect to carol and get the reward amount for her stake
        await depository.connect(carol).getReward();

        const carolReward = Number(await ohm.balanceOf(carol.address));
        console.log("carolReward", carolReward);
        const carolsBalanceNow = await ohm.balanceOf(carol.address);
        console.log("Carol's New Balance", carolsBalanceNow);
        const [, , , td, , ,] = await depository.markets(0);
        console.log("CURRENT DEBT", td);
    });

    it("run long term operations", async () => {});

    it("should decay a max payout in target deposit interval", async () => {
        const [, , , , , maxPayout, ,] = await depository.markets(bid);
        const price = await depository.marketPrice(bid);
        const amount = (maxPayout as any) * (price as any);
        await depository.connect(bob).deposit(
            bid,
            amount, // amount for max payout
            initialPrice,
            bob.address,
            carol.address
        );
        await network.provider.send("evm_increaseTime", [depositInterval]);
        const newPrice = await depository.marketPrice(bid);
        expect(Number(newPrice)).to.be.lessThan(initialPrice);
    });
});
