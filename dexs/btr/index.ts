import { FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";

// BTR DEX (AIMM) - adaptive inventory market maker, live on Monad mainnet (chainId 143).
// Pools are deterministic CREATE3 PoolProxy instances minted by the PoolFactory below (same address
// on every chain BTR deploys to). Every fill emits one canonical `Swapped` event on the pool:
// `amounts` is packed `amountIn | amountOut << 128` and `fees` is `protoFee | lpFee << 128`. The
// whole fee is charged on the output leg, in `tokenOut` units; there is no input-leg fee and no
// separate fee-transfer transaction (source: dex-evm/src/interfaces/IPool.sol `Swapped`,
// dex-evm/src/libraries/PricingLib.sol `_settleAndPay`).
//
// Volume counts EVERY fill, including BTR's own coop-arbitrage fills. `Pool.swapCoop_cd` is
// callable only by addresses holding the COOP_ENABLED permission bit, which is granted only to
// BTR's own CoopArb contracts (protocol-owned atomic arbitrage). Those fills are real pool swaps:
// they move inventory against external venues and pay a non-zero LP fee, so excluding them left the
// whole series at zero while coop arb was the only flow. They are included here by the protocol's
// listing decision; the coop lane books a protocol fee of exactly zero, so a coop-only window shows
// volume and LP revenue with a protocol revenue of 0 (a measured zero, not a missing value).
//
// Fees vs revenue follows the DefiLlama convention (and Uniswap's own listing): `fees` is the whole
// swap fee the taker paid (LP share + protocol share), `revenue` is the protocol's share of it, and
// `supplySideRevenue` is the LP share. Uniswap reports swap fees as LP fees where its protocol fee
// is off, and protocol revenue only where a protocol fee is switched on; the two are the same
// identity, and a DEX with no protocol fee correctly reports zero revenue while its fees stay
// non-zero. BTR's protocol fee is switched on for public fills and zero on the coop lane.
//
// Liability conversions are volume too. `LiabilitySwapped` is emitted by `withdrawTo` when the
// LP exits into ANOTHER token than its claim (a cross-asset exit: the claim is converted through
// the same anchor-path quote a swap uses, then paid out) and by `swapLiability` (the claim is
// re-denominated into another leg, nothing paid out). Each is counted ONCE, on its output leg:
// - cross exit (`lpAmountOut == 0`): the pool's next `Withdrawn(sender, tokenOut, amount, 0)` in
//   the same transaction is the payout; `amount` of `tokenOut` is the volume, and that Withdrawn
//   is never counted again (a same-asset withdraw is liquidity, not volume);
// - `swapLiability` (`lpAmountOut > 0`): the minted claim's token value, `previewWithdraw` face
//   (amountOut + haircut) of `lpAmountOut` `tokenOut` shares at the window's end block.
// v1 logs no route fee on either, so v1 conversions add volume only; v2's `LiabilitySwapped` carries
// it (`fees`, tokenOut units) and it is booked like a swap fee, protocol and LP shares apart.
const FACTORY = "0xbbbbbbbbbd5e955E20F323cA1F95f8191fD0E0BF";

const SWAPPED =
  "event Swapped(address indexed sender, address indexed recipient, address indexed tokenIn, address tokenOut, uint256 amounts, uint256 fees, uint256 prices, uint256 outBook, uint256 outState)";

const LIABILITY_SWAPPED =
  "event LiabilitySwapped(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 lpAmountIn, uint256 lpAmountOut, uint256 haircut)";
// v2 pools add the conversion's route fee, packed `protoFee | lpFee << 128` in tokenOut units as on
// `Swapped`: a trailing field is a new topic0, so v1 history keeps the fee-less shape above.
const LIABILITY_SWAPPED_V2 =
  "event LiabilitySwapped(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 lpAmountIn, uint256 lpAmountOut, uint256 haircut, uint256 fees)";
const WITHDRAWN =
  "event Withdrawn(address indexed sender, address indexed token, uint256 amount, uint256 lpAmount)";

const abi = {
  previewWithdraw: "function previewWithdraw(address tk, uint256 lp) view returns (uint256 amountOut, uint256 haircut)",
  getOfficialPoolsCount: "function getOfficialPoolsCount() view returns (uint256)",
  officialPools: "function officialPools(uint256) view returns (address)",
};

const U128 = (1n << 128n) - 1n;

// Only chains with a live pool factory are listed. Monad is the sole live mainnet deployment
// (dex-evm deployments/143.pools.json); BNB (56) is a zeroed scaffold, Base has no pool factory
// record and Arc is a testnet, so they are intentionally absent.
const chainConfig: Record<string, { start: string }> = {
  [CHAIN.MONAD]: { start: "2026-10-01" }, // PoolFactory.createPool, block 109610388
};

const fetch = async (options: FetchOptions) => {
  const dailyVolume = options.createBalances();
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  const count = Number(await options.api.call({ target: FACTORY, abi: abi.getOfficialPoolsCount }));
  const pools: string[] = count
    ? await options.api.multiCall({
        target: FACTORY,
        abi: abi.officialPools,
        calls: Array.from({ length: count }, (_, i) => ({ params: [i] })),
      })
    : [];
  const logs = pools.length ? await options.getLogs({ targets: pools, eventAbi: SWAPPED }) : [];

  const lower = (a: string) => a.toLowerCase();
  const positioned = (eventAbi: string): Promise<any[]> =>
    pools.length ? options.getLogs({ targets: pools, eventAbi, entireLog: true, parseLog: true }) : Promise.resolve([]);
  const liabilityLogs = [...(await positioned(LIABILITY_SWAPPED)), ...(await positioned(LIABILITY_SWAPPED_V2))];
  const withdrawLogs = await positioned(WITHDRAWN);
  const txPool = (l: any) => `${lower(l.transactionHash)}|${lower(l.address)}`;
  const conversionsAt = new Map<string, number[]>();
  for (const l of liabilityLogs) conversionsAt.set(txPool(l), [...(conversionsAt.get(txPool(l)) ?? []), Number(l.logIndex)]);
  const payouts = new Map<string, any[]>();
  for (const w of withdrawLogs) {
    payouts.set(txPool(w), [...(payouts.get(txPool(w)) ?? []), w]);
  }
  const mints: { pool: string; token: string; lp: bigint }[] = [];
  for (const l of liabilityLogs) {
    const { sender, tokenOut, lpAmountOut, fees } = l.args;
    if (fees !== undefined) {
      const protoFee = BigInt(fees) & U128;
      const lpFee = BigInt(fees) >> 128n;
      dailyFees.add(tokenOut, protoFee + lpFee, "Conversion Fees");
      dailyRevenue.add(tokenOut, protoFee, "Conversion Fees To Protocol");
      dailySupplySideRevenue.add(tokenOut, lpFee, "Conversion Fees To LPs");
    }
    if (BigInt(lpAmountOut) > 0n) {
      mints.push({ pool: l.address, token: tokenOut, lp: BigInt(lpAmountOut) });
      continue;
    }
    // The cross exit's payout: the pool's first lpAmount-0 Withdrawn after it in the same
    // transaction, before the pool's next conversion. A same-asset withdraw always burns shares,
    // so it is never taken for the payout.
    const at = Number(l.logIndex);
    const until = Math.min(...(conversionsAt.get(txPool(l)) ?? []).filter((i) => i > at), Infinity);
    const next = (payouts.get(txPool(l)) ?? [])
      .filter((w) => Number(w.logIndex) > at && Number(w.logIndex) < until && BigInt(w.args.lpAmount) === 0n)
      .sort((a, b) => Number(a.logIndex) - Number(b.logIndex))[0];
    if (next && lower(next.args.token) === lower(tokenOut) && lower(next.args.sender) === lower(sender))
      dailyVolume.add(tokenOut, next.args.amount, "Cross-Asset Withdrawals");
  }
  if (mints.length) {
    const previews = await options.api.multiCall({
      abi: abi.previewWithdraw,
      calls: mints.map((m) => ({ target: m.pool, params: [m.token, m.lp.toString()] })),
    });
    previews.forEach((p: any, i: number) =>
      dailyVolume.add(mints[i].token, BigInt(p.amountOut) + BigInt(p.haircut), "Liability Swaps")
    );
  }

  for (const log of logs) {
    const amounts = BigInt(log.amounts);
    const fees = BigInt(log.fees);
    const protoFee = fees & U128;
    const lpFee = fees >> 128n;
    // Input-leg amount only, counted once per fill: the input leg is the notional the taker
    // actually moved, and the fee is charged on the output leg so it is not double-counted here.
    dailyVolume.add(log.tokenIn, amounts & U128, "Swaps");
    dailyFees.add(log.tokenOut, protoFee + lpFee, "Swap Fees");
    dailyRevenue.add(log.tokenOut, protoFee, "Swap Fees To Protocol");
    dailySupplySideRevenue.add(log.tokenOut, lpFee, "Swap Fees To LPs");
  }

  return {
    dailyVolume,
    dailyFees,
    dailyUserFees: dailyFees,
    dailyRevenue,
    dailyProtocolRevenue: dailyRevenue,
    dailySupplySideRevenue,
  };
};

const methodology = {
  Volume:
    "Input-token amount (amountIn) of every swap on BTR pools, read from the pool Swapped event and counted once per swap, including the protocol's own coop-arbitrage fills (CoopArb). Plus every liability conversion (LiabilitySwapped), counted once on its output leg: a cross-asset withdrawal (withdrawTo into another token) counts the token it paid out, read from its paired Withdrawn; a swapLiability counts the value of the claim it minted.",
  Fees:
    "Swap fee charged on the output token of each swap (protocol share plus LP share), read from the Swapped event, plus the route fee a v2 liability conversion logs on LiabilitySwapped (v1 conversions log none). The coverage toll a swap may pay when it drains a leg below its coverage floor stays in the leg's reserves as a buffer and is not counted.",
  UserFees: "All swap fees are paid by the swapper.",
  Revenue: "Protocol share (protoFee) of the swap fee. Zero on coop fills, which book no protocol fee.",
  ProtocolRevenue: "The protocol share (protoFee) of the swap fee goes to the BTR treasury.",
  SupplySideRevenue: "LP share (lpFee) of the swap fee, accrued to the liquidity providers of the output leg.",
};

const breakdownMethodology = {
  Volume: {
    Swaps: "Input-token amount of every Swapped fill, public and coop-arbitrage.",
    "Cross-Asset Withdrawals": "Output-token amount an LP withdrew into a different token than its claim (withdrawTo), read from the Withdrawn paired with its LiabilitySwapped.",
    "Liability Swaps": "Value of the claim a swapLiability re-denominated into another leg (previewWithdraw face of the minted shares).",
  },
  Fees: {
    "Swap Fees": "Swap fee charged on the output token of each swap (protocol share plus LP share).",
    "Conversion Fees": "Route fee a v2 liability conversion charged on its output token (protocol share plus LP share), read from LiabilitySwapped.",
  },
  UserFees: {
    "Swap Fees": "Swap fee charged on the output token of each swap (protocol share plus LP share).",
    "Conversion Fees": "Route fee a v2 liability conversion charged on its output token.",
  },
  Revenue: {
    "Swap Fees To Protocol": "Protocol share (protoFee) of the swap fee.",
    "Conversion Fees To Protocol": "Protocol share of a v2 liability conversion's route fee.",
  },
  ProtocolRevenue: {
    "Swap Fees To Protocol": "Protocol share (protoFee) of the swap fee, sent to the BTR treasury.",
    "Conversion Fees To Protocol": "Protocol share of a v2 liability conversion's route fee, booked to the BTR treasury.",
  },
  SupplySideRevenue: {
    "Swap Fees To LPs": "LP share (lpFee) of the swap fee, accrued to the output leg's liquidity providers.",
    "Conversion Fees To LPs": "LP share of a v2 liability conversion's route fee, accrued to the output leg's LPs.",
  },
};

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  adapter: chainConfig,
  methodology,
  breakdownMethodology,
};

export default adapter;
