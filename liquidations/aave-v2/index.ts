import { gql, request } from "graphql-request";
import { Liq } from "../utils/types";
import { getPagedGql } from "../utils/gql";

interface Reserve {
  symbol: string;
  usageAsCollateralEnabled: boolean;
  underlyingAsset: string;
  price: {
    priceInEth: string;
  };
  decimals: string;
  reserveLiquidationThreshold: string;
}

interface User {
  id: string;
  reserves: {
    usageAsCollateralEnabledOnUser: boolean;
    reserve: Reserve;
    currentATokenBalance: string;
    currentTotalDebt: string;
  }[];
}

enum Chains {
  ethereum = "ethereum",
}

interface AaveAdapterResource {
  name: "aave";
  chain: Chains;
  usdcAddress: string;
  subgraphUrl: string;
  explorerBaseUrl: string;
}

const rc: { [chain in Chains]: AaveAdapterResource } = {
  [Chains.ethereum]: {
    name: "aave",
    chain: Chains.ethereum,
    usdcAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    subgraphUrl: "https://api.thegraph.com/subgraphs/name/aave/protocol-v2",
    explorerBaseUrl: "https://etherscan.io/address/",
  },
};

const ethPriceQuery = (usdcAddress: string) => gql`
  {
    priceOracleAsset(id: "${usdcAddress}") {
      priceInEth
    }
  }
`;

const positions = (chain: Chains) => async () => {
  const { explorerBaseUrl, subgraphUrl, usdcAddress } = rc[chain];
  const _ethPriceQuery = ethPriceQuery(usdcAddress);
  const users = (await getPagedGql(rc[chain].subgraphUrl, query, "users")) as User[];
  const { priceOracleAsset } = await request(subgraphUrl, _ethPriceQuery);
  const ethPrice = 1 / (Number(priceOracleAsset.priceInEth) / 1e18);
  const liquidablePositions: Liq[] = [];

  users.forEach((user) => {
    let totalDebt = 0;
    let totalCollateral = 0;

    user.reserves.forEach((reserve) => {
      const decimals = 10 ** Number(reserve.reserve.decimals);
      const price = (Number(reserve.reserve.price.priceInEth) / 1e18) * ethPrice;
      const liqThreshold = Number(reserve.reserve.reserveLiquidationThreshold) / 1e4;
      let debt = Number(reserve.currentTotalDebt);

      if (reserve.usageAsCollateralEnabledOnUser) {
        debt -= Number(reserve.currentATokenBalance) * liqThreshold;
      }
      
      debt *= price / decimals;
      
      if (debt > 0) {
        totalDebt += debt;
      } else {
        totalCollateral -= debt;
      }

      if (debt < 0) {
        const usdPosNetCollateral = -debt;
        const otherCollateral = totalCollateral - usdPosNetCollateral;
        const diffDebt = totalDebt - otherCollateral;

        if (diffDebt > 0) {
          const amountCollateral = usdPosNetCollateral / price;
          const liqPrice = diffDebt / amountCollateral;
          liquidablePositions.push({
            owner: user.id,
            liqPrice,
            collateral: `${chain}:${reserve.reserve.underlyingAsset}`,
            collateralAmount: reserve.currentATokenBalance,
            extra: {
              url: explorerBaseUrl + user.id,
            },
          });
        }
      }
    });
  });

  return liquidablePositions;
};

export const ethereum = {
  liquidations: positions(Chains.ethereum),
};
