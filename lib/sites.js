/**
 * Station registry and published reference values.
 *
 * Coordinates for the six IMD stations in Yadav et al. (2025), plus the results
 * the paper reports, so a run here can be set beside the published numbers.
 */

export const SITES = {
  "Tuticorin": {
    "lat": 8.7642,
    "lon": 78.1348,
    "region": "Thoothukudi, Tamil Nadu",
    "terrain": "Coastal (Gulf of Mannar)",
    "aliases": ["tuticorin", "thoothukudi", "tuty"]
  },
  "Calcutta": {
    "lat": 22.5726,
    "lon": 88.3639,
    "region": "Kolkata, West Bengal",
    "terrain": "Coastal delta (Bay of Bengal)",
    "aliases": ["calcutta", "kolkata", "cal"]
  },
  "Ahmedabad": {
    "lat": 23.0225,
    "lon": 72.5714,
    "region": "Ahmedabad, Gujarat",
    "terrain": "Semi-arid inland",
    "aliases": ["ahmedabad", "amdavad", "ahd"]
  },
  "Jaipur": {
    "lat": 26.9124,
    "lon": 75.7873,
    "region": "Jaipur, Rajasthan",
    "terrain": "Arid inland",
    "aliases": ["jaipur", "jpr"]
  },
  "Madras": {
    "lat": 13.0827,
    "lon": 80.2707,
    "region": "Chennai, Tamil Nadu",
    "terrain": "Coastal (Coromandel)",
    "aliases": ["madras", "chennai", "mad"]
  },
  "Mormugao": {
    "lat": 15.4009,
    "lon": 73.8009,
    "region": "Mormugao, Goa",
    "terrain": "Coastal (Arabian Sea)",
    "aliases": ["mormugao", "marmagao", "goa", "vasco"]
  }
};

/** Table 1: per-site RMSE / MAE on the min-max scaled target. */
export const PAPER_TABLE1 = {
  "Tuticorin": {
    "LSTM": [0.08653, 0.06047],
    "GBM": [0.08569, 0.06003],
    "RF": [0.08715, 0.06092],
    "CNN": [0.10275, 0.07549]
  },
  "Ahmedabad": {
    "LSTM": [0.08428, 0.06234],
    "GBM": [0.08406, 0.06181],
    "RF": [0.08636, 0.06324],
    "CNN": [0.09519, 0.07313]
  },
  "Jaipur": {
    "LSTM": [0.18578, 0.15074],
    "GBM": [0.07304, 0.05416],
    "RF": [0.07498, 0.0561],
    "CNN": [0.08214, 0.0623]
  },
  "Calcutta": {
    "LSTM": [0.01803, 0.01097],
    "GBM": [0.01788, 0.01078],
    "RF": [0.01716, 0.01069],
    "CNN": [0.01874, 0.01099]
  },
  "Madras": {
    "LSTM": [0.06207, 0.04505],
    "GBM": [0.05861, 0.03987],
    "RF": [0.06045, 0.04064],
    "CNN": [0.06956, 0.052]
  },
  "Mormugao": {
    "LSTM": [0.07145, 0.05409],
    "GBM": [0.06855, 0.04786],
    "RF": [0.06857, 0.0477],
    "CNN": [0.08674, 0.06021]
  }
};

/** Table S5: pooled across sites, with bootstrap intervals. */
export const PAPER_POOLED = {
  "GBM": {
    "rmse": 0.086,
    "rmse_ci": [0.077, 0.095],
    "mae": 0.06,
    "mae_ci": [0.055, 0.065]
  },
  "RF": {
    "rmse": 0.086,
    "rmse_ci": [0.077, 0.095],
    "mae": 0.061,
    "mae_ci": [0.056, 0.066]
  },
  "LSTM": {
    "rmse": 0.092,
    "rmse_ci": null,
    "mae": null,
    "mae_ci": null
  },
  "CNN": {
    "rmse": 0.104,
    "rmse_ci": [0.095, 0.113],
    "mae": null,
    "mae_ci": null
  }
};

/** P95 tail robustness, pooled. */
export const PAPER_TAIL = {
  "tail_rmse": 0.14,
  "tail_rmse_ci": [0.126, 0.159],
  "tail_mae": 0.12,
  "tail_mae_ci": [0.108, 0.136],
  "exceedance_recall": 0.209,
  "exceedance_recall_ci": [0.074, 0.33]
};

/** Weibull and power-density values quoted for individual sites. */
export const PAPER_WPD_REFERENCE = {
  "Tuticorin": {
    "peak_month": "Jul",
    "wpd_100": 916.19,
    "wpd_120": 990.65,
    "wpd_150": 1090.06,
    "k_anemometer": 3.94,
    "mws_100": 9.85,
    "mws_120": 10.11,
    "mws_150": 10.44
  },
  "Jaipur": {
    "peak_month": "Nov (lowest)",
    "wpd_100": 11.79,
    "wpd_120": 12.75,
    "wpd_150": 14.03,
    "mws_100": 1.83,
    "mws_120": 1.88,
    "mws_150": 1.94
  },
  "Calcutta": {
    "k_anemometer": 0.88
  }
};

/** Fig. 7: R-squared for the ML forecast against the Weibull distribution fit. */
export const PAPER_R2_COMPARISON = {
  "Tuticorin": {
    "ml": 0.993,
    "weibull": 0.8986
  },
  "Ahmedabad": {
    "ml": 0.9833,
    "weibull": 0.2531
  },
  "Jaipur": {
    "ml": 0.9885,
    "weibull": 0.873
  }
};

/** Guess the station from an uploaded file name. Returns null when unclear. */
export function detectSite(filename) {
  if (!filename) return null;
  const stem = filename.toLowerCase();
  for (const [name, meta] of Object.entries(SITES)) {
    for (const alias of meta.aliases) {
      if (stem.includes(alias)) return name;
    }
  }
  return null;
}
