-- Hermes Polybot schema. Paper trading only.
CREATE TABLE IF NOT EXISTS LeaderboardScan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  scannedAt TEXT NOT NULL,
  walletCount INTEGER NOT NULL,
  lookbackDays INTEGER NOT NULL,
  rawSummaryJson TEXT,
  isDemo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS WalletProfile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  label TEXT,
  sourceRank INTEGER,
  status TEXT NOT NULL DEFAULT 'watch' CHECK (status IN ('track','watch','ignore')),
  statusReason TEXT,
  roi30d REAL,
  consistencyScore REAL,
  copyabilityScore REAL,
  oneHitWonderPenalty REAL,
  globalScore REAL,
  bestCategory TEXT,
  categoryStrengthsJson TEXT,
  averageTradeSize REAL,
  tradeCount30d INTEGER,
  resolvedTradeCount30d INTEGER,
  winRate30d REAL,
  averageLiquidity REAL,
  averageSpread REAL,
  averageEntryTiming REAL,
  copyabilityNotes TEXT,
  riskNotes TEXT,
  lastScannedAt TEXT,
  isDemo INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ObservedTrade (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  walletAddress TEXT NOT NULL,
  marketId TEXT NOT NULL,
  conditionId TEXT,
  marketQuestion TEXT,
  marketCategory TEXT,
  outcome TEXT,
  side TEXT,
  walletEntryPrice REAL,
  detectedPrice REAL,
  size REAL,
  timestamp TEXT NOT NULL,
  rawTradeJson TEXT,
  isDemo INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS MarketSnapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketId TEXT NOT NULL,
  conditionId TEXT,
  question TEXT,
  category TEXT,
  yesPrice REAL,
  noPrice REAL,
  bestBid REAL,
  bestAsk REAL,
  spread REAL,
  liquidity REAL,
  volume REAL,
  timeToResolution REAL,
  collectedAt TEXT NOT NULL,
  rawMarketJson TEXT,
  isDemo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS DecisionJournal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observedTradeId INTEGER REFERENCES ObservedTrade(id),
  walletAddress TEXT NOT NULL,
  marketId TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('paper_copy','watchlist','skip')),
  copyScore REAL,
  confidence REAL,
  reasonsJson TEXT,
  risksJson TEXT,
  walletQualityScore REAL,
  roiScore REAL,
  consistencyScore REAL,
  copyabilityScore REAL,
  categoryFitScore REAL,
  entryTimingScore REAL,
  spreadScore REAL,
  liquidityScore REAL,
  thesisScore REAL,
  simulatedPositionSize REAL,
  reviewOutcome TEXT,
  isDemo INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS PaperTrade (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decisionJournalId INTEGER REFERENCES DecisionJournal(id),
  walletAddress TEXT NOT NULL,
  marketId TEXT NOT NULL,
  outcome TEXT,
  side TEXT,
  entryPrice REAL NOT NULL,
  currentPrice REAL,
  simulatedPositionSize REAL NOT NULL CHECK (simulatedPositionSize >= 5 AND simulatedPositionSize <= 20),
  unrealizedPnl REAL DEFAULT 0,
  realizedPnl REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','resolved')),
  reason TEXT,
  isDemo INTEGER NOT NULL DEFAULT 0,
  openedAt TEXT NOT NULL DEFAULT (datetime('now')),
  closedAt TEXT,
  resolvedAt TEXT
);

CREATE TABLE IF NOT EXISTS PnlSnapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paperTradeId INTEGER NOT NULL REFERENCES PaperTrade(id),
  price REAL NOT NULL,
  pnl REAL NOT NULL,
  collectedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS OutcomeReview (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decisionJournalId INTEGER REFERENCES DecisionJournal(id),
  paperTradeId INTEGER REFERENCES PaperTrade(id),
  reviewTime TEXT NOT NULL,
  priceAfter1h REAL,
  priceAfter6h REAL,
  priceAfter24h REAL,
  finalOutcome TEXT,
  simulatedPnl REAL,
  wasDecisionGood INTEGER,
  lessonsJson TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS RuleSet (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 0,
  rulesJson TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS RuleChange (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oldRuleSetId INTEGER REFERENCES RuleSet(id),
  newRuleSetId INTEGER NOT NULL REFERENCES RuleSet(id),
  changedBy TEXT NOT NULL DEFAULT 'hermes',
  reason TEXT NOT NULL,
  evidenceSummary TEXT,
  beforeJson TEXT,
  afterJson TEXT,
  expectedImprovement TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS DailyReport (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  paperPnl REAL,
  winRate REAL,
  openPositions INTEGER,
  newSignals INTEGER,
  copiedSignals INTEGER,
  watchedSignals INTEGER,
  skippedSignals INTEGER,
  bestWalletsJson TEXT,
  worstWalletsJson TEXT,
  ruleChangesJson TEXT,
  summary TEXT,
  sentToTelegram INTEGER NOT NULL DEFAULT 0,
  isDemo INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_observed_wallet ON ObservedTrade(walletAddress);
CREATE INDEX IF NOT EXISTS idx_snapshot_market ON MarketSnapshot(marketId, collectedAt);
CREATE INDEX IF NOT EXISTS idx_journal_decision ON DecisionJournal(decision);
CREATE INDEX IF NOT EXISTS idx_paper_status ON PaperTrade(status);
CREATE INDEX IF NOT EXISTS idx_pnl_trade ON PnlSnapshot(paperTradeId);
