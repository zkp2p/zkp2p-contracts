import "module-alias/register";

import { Contract } from "ethers";
import { ethers } from "hardhat";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { usdc } from "@utils/common";

const expect = getWaffleExpect();

describe("ReferralFeeSplitter", () => {
  let owner: Account;
  let sender: Account;
  let payeeA: Account;
  let payeeB: Account;
  let payeeC: Account;

  let deployer: DeployHelper;
  let usdcToken: Contract;
  let splitter: Contract;

  beforeEach(async () => {
    [owner, sender, payeeA, payeeB, payeeC] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");
    await usdcToken.transfer(sender.address, usdc(10_000));

    const ReferralFeeSplitter = await ethers.getContractFactory("ReferralFeeSplitter", owner.wallet);
    splitter = await ReferralFeeSplitter.deploy(
      [payeeA.address, payeeB.address, payeeC.address],
      [50, 30, 20]
    );
  });

  it("splits received ERC20 referral fees pro-rata via pull payments", async () => {
    await usdcToken.connect(sender.wallet).transfer(splitter.address, usdc(1000));

    await splitter.connect(payeeA.wallet)["release(address,address)"](usdcToken.address, payeeA.address);
    await splitter.connect(payeeB.wallet)["release(address,address)"](usdcToken.address, payeeB.address);
    await splitter.connect(payeeC.wallet)["release(address,address)"](usdcToken.address, payeeC.address);

    expect(await usdcToken.balanceOf(payeeA.address)).to.eq(usdc(500));
    expect(await usdcToken.balanceOf(payeeB.address)).to.eq(usdc(300));
    expect(await usdcToken.balanceOf(payeeC.address)).to.eq(usdc(200));
    expect(await usdcToken.balanceOf(splitter.address)).to.eq(usdc(0));
  });
});

