// Curated 40-ticker NSE universe with seed volatility tiers, used until each
// symbol has accumulated enough live ticks this session (see volatility.ts).
//
// Every symbol below was checked directly against the Yahoo Finance v8 chart
// endpoint (the actual data source we use — see marketData.ts) on 2026-09-04.
// The original list this was drafted from had two stale tickers from real
// corporate actions that predate that check:
//   - ZOMATO.NS no longer resolves: the company renamed to Eternal Ltd,
//     new ticker ETERNAL.NS.
//   - TATAMOTORS.NS no longer resolves: Tata Motors demerged in Nov 2025
//     into Tata Motors Passenger Vehicles (TMPV.NS) and a separately listed
//     commercial vehicles business (TMCV.NS). We use TMPV.NS as the 1:1
//     replacement here.
// Both fixes are reflected below.

export interface NSEStockSeed {
  symbol: string; // Yahoo Finance ticker, e.g. RELIANCE.NS
  name: string;
  sector: string;
  volatilityTier: "HIGH" | "MED" | "LOW";
  baseSigma: number; // seed daily-return stdev, used only until live data takes over
}

export const NSE_40_UNIVERSE: NSEStockSeed[] = [
  // ------------------------------------------------------------------
  // HIGH VOLATILITY (high beta, Adani group, small/mid-cap, growth)
  // ------------------------------------------------------------------
  { symbol: "ADANIENT.NS", name: "Adani Enterprises", sector: "Metals & Mining", volatilityTier: "HIGH", baseSigma: 0.038 },
  { symbol: "ADANIPORTS.NS", name: "Adani Ports", sector: "Infrastructure", volatilityTier: "HIGH", baseSigma: 0.032 },
  { symbol: "TMPV.NS", name: "Tata Motors Passenger Vehicles", sector: "Automobile", volatilityTier: "HIGH", baseSigma: 0.028 },
  { symbol: "BAJFINANCE.NS", name: "Bajaj Finance", sector: "NBFC", volatilityTier: "HIGH", baseSigma: 0.027 },
  { symbol: "ETERNAL.NS", name: "Eternal Ltd (Zomato/Blinkit)", sector: "Consumer Tech", volatilityTier: "HIGH", baseSigma: 0.035 },
  { symbol: "PAYTM.NS", name: "One97 Communications", sector: "Fintech", volatilityTier: "HIGH", baseSigma: 0.038 },
  { symbol: "JIOFIN.NS", name: "Jio Financial Services", sector: "Financial Services", volatilityTier: "HIGH", baseSigma: 0.03 },
  { symbol: "PERSISTENT.NS", name: "Persistent Systems", sector: "IT Services", volatilityTier: "HIGH", baseSigma: 0.029 },
  { symbol: "IRFC.NS", name: "Indian Railway Finance", sector: "PSU Financial", volatilityTier: "HIGH", baseSigma: 0.034 },
  { symbol: "SUZLON.NS", name: "Suzlon Energy", sector: "Renewable Energy", volatilityTier: "HIGH", baseSigma: 0.04 },
  { symbol: "YESBANK.NS", name: "Yes Bank", sector: "Banking", volatilityTier: "HIGH", baseSigma: 0.036 },
  { symbol: "TATASTEEL.NS", name: "Tata Steel", sector: "Metals", volatilityTier: "HIGH", baseSigma: 0.026 },

  // ------------------------------------------------------------------
  // MEDIUM VOLATILITY (large-cap IT, private banks, auto, energy)
  // ------------------------------------------------------------------
  { symbol: "RELIANCE.NS", name: "Reliance Industries", sector: "Oil & Telecom", volatilityTier: "MED", baseSigma: 0.016 },
  { symbol: "INFY.NS", name: "Infosys Ltd", sector: "IT Services", volatilityTier: "MED", baseSigma: 0.018 },
  { symbol: "TCS.NS", name: "Tata Consultancy Services", sector: "IT Services", volatilityTier: "MED", baseSigma: 0.015 },
  { symbol: "ICICIBANK.NS", name: "ICICI Bank", sector: "Banking", volatilityTier: "MED", baseSigma: 0.017 },
  { symbol: "AXISBANK.NS", name: "Axis Bank", sector: "Banking", volatilityTier: "MED", baseSigma: 0.02 },
  { symbol: "SBIN.NS", name: "State Bank of India", sector: "PSU Banking", volatilityTier: "MED", baseSigma: 0.021 },
  { symbol: "BHARTIARTL.NS", name: "Bharti Airtel", sector: "Telecom", volatilityTier: "MED", baseSigma: 0.016 },
  { symbol: "LT.NS", name: "Larsen & Toubro", sector: "Engineering", volatilityTier: "MED", baseSigma: 0.017 },
  { symbol: "MARUTI.NS", name: "Maruti Suzuki", sector: "Automobile", volatilityTier: "MED", baseSigma: 0.018 },
  { symbol: "TITAN.NS", name: "Titan Company", sector: "Consumer Durables", volatilityTier: "MED", baseSigma: 0.019 },
  { symbol: "M&M.NS", name: "Mahindra & Mahindra", sector: "Automobile", volatilityTier: "MED", baseSigma: 0.021 },
  { symbol: "SUNPHARMA.NS", name: "Sun Pharma", sector: "Pharmaceuticals", volatilityTier: "MED", baseSigma: 0.015 },
  { symbol: "NTPC.NS", name: "NTPC Ltd", sector: "Power", volatilityTier: "MED", baseSigma: 0.019 },
  { symbol: "ONGC.NS", name: "Oil & Natural Gas Corp", sector: "Oil & Gas", volatilityTier: "MED", baseSigma: 0.022 },
  { symbol: "WIPRO.NS", name: "Wipro Ltd", sector: "IT Services", volatilityTier: "MED", baseSigma: 0.019 },
  { symbol: "HCLTECH.NS", name: "HCL Technologies", sector: "IT Services", volatilityTier: "MED", baseSigma: 0.017 },

  // ------------------------------------------------------------------
  // LOW VOLATILITY (FMCG, mega blue chips, staples, utilities)
  // ------------------------------------------------------------------
  { symbol: "HDFCBANK.NS", name: "HDFC Bank", sector: "Banking", volatilityTier: "LOW", baseSigma: 0.013 },
  { symbol: "ITC.NS", name: "ITC Ltd", sector: "FMCG", volatilityTier: "LOW", baseSigma: 0.011 },
  { symbol: "HINDUNILVR.NS", name: "Hindustan Unilever", sector: "FMCG", volatilityTier: "LOW", baseSigma: 0.01 },
  { symbol: "NESTLEIND.NS", name: "Nestle India", sector: "FMCG", volatilityTier: "LOW", baseSigma: 0.009 },
  { symbol: "BRITANNIA.NS", name: "Britannia Industries", sector: "FMCG", volatilityTier: "LOW", baseSigma: 0.011 },
  { symbol: "CIPLA.NS", name: "Cipla Ltd", sector: "Pharmaceuticals", volatilityTier: "LOW", baseSigma: 0.012 },
  { symbol: "POWERGRID.NS", name: "Power Grid Corp", sector: "Utilities", volatilityTier: "LOW", baseSigma: 0.012 },
  { symbol: "COALINDIA.NS", name: "Coal India", sector: "Mining & Power", volatilityTier: "LOW", baseSigma: 0.013 },
  { symbol: "DABUR.NS", name: "Dabur India", sector: "FMCG", volatilityTier: "LOW", baseSigma: 0.011 },
  { symbol: "PIDILITIND.NS", name: "Pidilite Industries", sector: "Chemicals", volatilityTier: "LOW", baseSigma: 0.012 },
  { symbol: "ASIANPAINT.NS", name: "Asian Paints", sector: "Consumer Paints", volatilityTier: "LOW", baseSigma: 0.013 },
  { symbol: "BAJAJ-AUTO.NS", name: "Bajaj Auto", sector: "Automobile", volatilityTier: "LOW", baseSigma: 0.013 },
];
