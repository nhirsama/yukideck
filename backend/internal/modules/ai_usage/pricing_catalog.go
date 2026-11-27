package ai_usage

// RateCard holds USD prices per 1M tokens.
type RateCard struct {
	InputPerM        float64
	OutputPerM       float64
	CacheReadPerM    float64
	CacheWritePerM   float64
	CacheWrite1hPerM float64
}

// PriceVersion defines the base unit prices and tag multipliers taking effect at EffectiveFrom.
//   - EffectiveFrom: "" means the initial baseline price covering all earlier timestamps.
//     Otherwise accepts RFC3339 (e.g. "2026-03-01T00:00:00+08:00") or UTC date ("2026-03-01").
//   - TagMultipliers: plain tag -> multiplier map (e.g. {"peak": 2, "fast": 2}).
//     Missing tags default to 1.0; multiple matched tags multiply together.
type PriceVersion struct {
	EffectiveFrom  string
	Base           RateCard
	TagMultipliers map[string]float64
}

// BillingModelPricing defines the pricing version history for one canonical billing model key.
// MatchPrefix allows unknown suffixed variants (e.g. "gpt-5.3-codex-spark" -> "gpt-5.3-codex")
// to fall back to the longest matching billing model key when no exact match exists.
type BillingModelPricing struct {
	BillingModel string
	MatchPrefix  bool
	Versions     []PriceVersion
}

func baseOnly(billingModel string, matchPrefix bool, base RateCard) BillingModelPricing {
	return BillingModelPricing{
		BillingModel: billingModel,
		MatchPrefix:  matchPrefix,
		Versions:     []PriceVersion{{Base: base}},
	}
}

// builtinBillingCatalog is compiled from cleaned official pricing history
// (official_price_changes.csv + official_multipliers.csv + models.dev cache tiers).
// DeepSeek V4 peak/off-peak models store off-peak base prices with TagMultipliers["peak"] = 2.
var builtinBillingCatalog = []BillingModelPricing{
	// Anthropic Claude
	baseOnly("claude-2.1", false, RateCard{InputPerM: 8, OutputPerM: 24}),
	baseOnly("claude-3-opus", false, RateCard{InputPerM: 15, OutputPerM: 75, CacheReadPerM: 1.5, CacheWritePerM: 18.75, CacheWrite1hPerM: 30}),
	baseOnly("claude-3-sonnet", false, RateCard{InputPerM: 3, OutputPerM: 15}),
	{
		BillingModel: "claude-3.5-haiku",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1, OutputPerM: 5, CacheReadPerM: 0.1, CacheWritePerM: 1.25, CacheWrite1hPerM: 2}},
			{EffectiveFrom: "2025-02-28T12:24:03+08:00", Base: RateCard{InputPerM: 0.8, OutputPerM: 4, CacheReadPerM: 0.08, CacheWritePerM: 1, CacheWrite1hPerM: 1.6}},
		},
	},
	baseOnly("claude-3.5-sonnet", false, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.3, CacheWritePerM: 3.75, CacheWrite1hPerM: 6}),
	baseOnly("claude-3.7-sonnet", false, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.3, CacheWritePerM: 3.75, CacheWrite1hPerM: 6}),
	baseOnly("claude-fable-5", false, RateCard{InputPerM: 10, OutputPerM: 50, CacheReadPerM: 1, CacheWritePerM: 12.5, CacheWrite1hPerM: 20}),
	baseOnly("claude-fable-5.1", false, RateCard{InputPerM: 10, OutputPerM: 50, CacheReadPerM: 0.25, CacheWritePerM: 12.5, CacheWrite1hPerM: 20}),
	{
		BillingModel: "claude-fable-5.2",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 8, OutputPerM: 40, CacheReadPerM: 0.2, CacheWritePerM: 10, CacheWrite1hPerM: 16}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("claude-haiku-4.5", false, RateCard{InputPerM: 1, OutputPerM: 5, CacheReadPerM: 0.1, CacheWritePerM: 1.25, CacheWrite1hPerM: 2}),
	baseOnly("claude-haiku-5.5", false, RateCard{InputPerM: 0.1, OutputPerM: 0.5, CacheReadPerM: 0.01, CacheWritePerM: 0.125, CacheWrite1hPerM: 0.2}),
	baseOnly("claude-instant-1", false, RateCard{InputPerM: 1.63, OutputPerM: 5.51}),
	baseOnly("claude-instant-1.2", false, RateCard{InputPerM: 0.163, OutputPerM: 0.551}),
	baseOnly("claude-mythos-5", false, RateCard{InputPerM: 10, OutputPerM: 50, CacheReadPerM: 1, CacheWritePerM: 12.5, CacheWrite1hPerM: 20}),
	baseOnly("claude-mythos-5.1", false, RateCard{InputPerM: 10, OutputPerM: 50, CacheReadPerM: 0.25, CacheWritePerM: 12.5, CacheWrite1hPerM: 20}),
	baseOnly("claude-mythos-5.2", false, RateCard{InputPerM: 8, OutputPerM: 40, CacheReadPerM: 0.2, CacheWritePerM: 10, CacheWrite1hPerM: 16}),
	baseOnly("claude-opus-4", false, RateCard{InputPerM: 15, OutputPerM: 75, CacheReadPerM: 1.5, CacheWritePerM: 18.75, CacheWrite1hPerM: 30}),
	baseOnly("claude-opus-4.0", false, RateCard{InputPerM: 15, OutputPerM: 75, CacheReadPerM: 1.5}),
	baseOnly("claude-opus-4.1", false, RateCard{InputPerM: 15, OutputPerM: 75, CacheReadPerM: 1.5, CacheWritePerM: 18.75, CacheWrite1hPerM: 30}),
	baseOnly("claude-opus-4.5", false, RateCard{InputPerM: 5, OutputPerM: 25, CacheReadPerM: 1.5, CacheWritePerM: 6.25, CacheWrite1hPerM: 10}),
	baseOnly("claude-opus-4.6", false, RateCard{InputPerM: 5, OutputPerM: 25, CacheReadPerM: 0.5, CacheWritePerM: 6.25, CacheWrite1hPerM: 10}),
	baseOnly("claude-opus-4.7", false, RateCard{InputPerM: 5, OutputPerM: 25, CacheReadPerM: 0.5, CacheWritePerM: 6.25, CacheWrite1hPerM: 10}),
	{
		BillingModel: "claude-opus-4.8",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 5, OutputPerM: 25, CacheReadPerM: 0.5, CacheWritePerM: 6.25, CacheWrite1hPerM: 10}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "claude-opus-5",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 5, OutputPerM: 25, CacheReadPerM: 0.5, CacheWritePerM: 6.25, CacheWrite1hPerM: 10}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "claude-opus-5.5",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 4, OutputPerM: 20, CacheReadPerM: 0.2, CacheWritePerM: 5, CacheWrite1hPerM: 8}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("claude-sonnet-4", false, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.3, CacheWritePerM: 3.75, CacheWrite1hPerM: 6}),
	baseOnly("claude-sonnet-4.0", false, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.3}),
	baseOnly("claude-sonnet-4.5", false, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.3, CacheWritePerM: 3.75, CacheWrite1hPerM: 6}),
	baseOnly("claude-sonnet-4.6", false, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.3, CacheWritePerM: 3.75, CacheWrite1hPerM: 6}),
	baseOnly("claude-sonnet-5", false, RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.2, CacheWritePerM: 2.5, CacheWrite1hPerM: 4}),
	baseOnly("claude-sonnet-5.5", false, RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.2, CacheWritePerM: 2.5, CacheWrite1hPerM: 4}),
	{
		BillingModel: "claude-fable-latest",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 8, OutputPerM: 40, CacheReadPerM: 0.2, CacheWritePerM: 10, CacheWrite1hPerM: 16}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("claude-mythos-preview", false, RateCard{InputPerM: 10, OutputPerM: 50, CacheReadPerM: 1, CacheWritePerM: 12.5, CacheWrite1hPerM: 20}),
	{
		BillingModel: "claude-opus-latest",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 4, OutputPerM: 20, CacheReadPerM: 0.2, CacheWritePerM: 5, CacheWrite1hPerM: 8}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("claude-sonnet-latest", false, RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.1, CacheWritePerM: 2.5, CacheWrite1hPerM: 4}),
	baseOnly("claude-haiku-latest", false, RateCard{InputPerM: 0.1, OutputPerM: 0.5, CacheReadPerM: 0.01, CacheWritePerM: 0.125, CacheWrite1hPerM: 0.2}),
	baseOnly("claude-sonnet-4.7", false, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.3, CacheWritePerM: 3.75, CacheWrite1hPerM: 6}),

	// OpenAI GPT / Codex / o-series
	baseOnly("chatgpt-4o", true, RateCard{InputPerM: 5, OutputPerM: 15}),
	baseOnly("codex-mini", true, RateCard{InputPerM: 1.5, OutputPerM: 6, CacheReadPerM: 0.375}),
	{
		BillingModel: "gpt-3.5-turbo",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.5, OutputPerM: 2}},
			{EffectiveFrom: "2025-07-23T08:22:50+08:00", Base: RateCard{InputPerM: 0.5, OutputPerM: 1.5}},
		},
	},
	baseOnly("gpt-3.5-turbo-16k", true, RateCard{InputPerM: 3, OutputPerM: 4}),
	baseOnly("gpt-3.5-turbo-instruct", true, RateCard{InputPerM: 1.5, OutputPerM: 2}),
	baseOnly("gpt-4", false, RateCard{InputPerM: 30, OutputPerM: 60}),
	baseOnly("gpt-4-32k", true, RateCard{InputPerM: 60, OutputPerM: 120}),
	baseOnly("gpt-4-all", true, RateCard{InputPerM: 30, OutputPerM: 60}),
	baseOnly("gpt-4-gizmo", true, RateCard{InputPerM: 30, OutputPerM: 60}),
	baseOnly("gpt-4-turbo", true, RateCard{InputPerM: 10, OutputPerM: 30}),
	{
		BillingModel: "gpt-4.1",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2, OutputPerM: 8, CacheReadPerM: 1}, TagMultipliers: map[string]float64{"fast": 1.75}},
		},
	},
	{
		BillingModel: "gpt-4.1-mini",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.4, OutputPerM: 1.6, CacheReadPerM: 0.1}, TagMultipliers: map[string]float64{"fast": 1.75}},
		},
	},
	baseOnly("gpt-4.1-nano", true, RateCard{InputPerM: 0.1, OutputPerM: 0.4, CacheReadPerM: 0.025}),
	baseOnly("gpt-4.5", true, RateCard{InputPerM: 75, OutputPerM: 150, CacheReadPerM: 37.5}),
	{
		BillingModel: "gpt-4o",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 5, OutputPerM: 15}, TagMultipliers: map[string]float64{"fast": 1.7}},
			{EffectiveFrom: "2024-10-03T08:00:00+08:00", Base: RateCard{InputPerM: 2.5, OutputPerM: 10, CacheReadPerM: 1.25}, TagMultipliers: map[string]float64{"fast": 1.7}},
		},
	},
	baseOnly("gpt-4o-all", true, RateCard{InputPerM: 30, OutputPerM: 60}),
	{
		BillingModel: "gpt-4o-gizmo",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 5, OutputPerM: 15}},
			{EffectiveFrom: "2025-09-19T14:20:15+08:00", Base: RateCard{InputPerM: 5, OutputPerM: 10}},
		},
	},
	{
		BillingModel: "gpt-4o-mini",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.15, OutputPerM: 0.6, CacheReadPerM: 0.075}, TagMultipliers: map[string]float64{"fast": 1.666667}},
		},
	},
	{
		BillingModel: "gpt-5",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.125}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("gpt-5-chat", true, RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.125}),
	baseOnly("gpt-5-codex", true, RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.125}),
	{
		BillingModel: "gpt-5-mini",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.25, OutputPerM: 2, CacheReadPerM: 0.025}, TagMultipliers: map[string]float64{"fast": 1.8}},
		},
	},
	baseOnly("gpt-5-nano", true, RateCard{InputPerM: 0.05, OutputPerM: 0.4, CacheReadPerM: 0.005}),
	baseOnly("gpt-5-pro", true, RateCard{InputPerM: 15, OutputPerM: 120}),
	baseOnly("gpt-5-search-api", true, RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.125}),
	{
		BillingModel: "gpt-5.1",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.13}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("gpt-5.1-chat", true, RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.125}),
	baseOnly("gpt-5.1-codex", true, RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.125}),
	baseOnly("gpt-5.1-codex-max", true, RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.125}),
	baseOnly("gpt-5.1-codex-mini", true, RateCard{InputPerM: 0.25, OutputPerM: 2, CacheReadPerM: 0.025}),
	{
		BillingModel: "gpt-5.2",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.75, OutputPerM: 14, CacheReadPerM: 0.175}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("gpt-5.2-chat", true, RateCard{InputPerM: 1.75, OutputPerM: 14, CacheReadPerM: 0.175}),
	baseOnly("gpt-5.2-codex", true, RateCard{InputPerM: 1.75, OutputPerM: 14, CacheReadPerM: 0.175}),
	baseOnly("gpt-5.2-pro", true, RateCard{InputPerM: 21, OutputPerM: 168}),
	baseOnly("gpt-5.3", true, RateCard{InputPerM: 1.75, OutputPerM: 14, CacheReadPerM: 0.175}),
	baseOnly("gpt-5.3-chat", true, RateCard{InputPerM: 1.75, OutputPerM: 14, CacheReadPerM: 0.175}),
	{
		BillingModel: "gpt-5.3-codex",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.75, OutputPerM: 14, CacheReadPerM: 0.175}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("gpt-5.3-codex-spark", true, RateCard{InputPerM: 1.75, OutputPerM: 14, CacheReadPerM: 0.175}),
	{
		BillingModel: "gpt-5.4",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2.5, OutputPerM: 15, CacheReadPerM: 0.25}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-5.4-mini",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.75, OutputPerM: 4.5, CacheReadPerM: 0.075}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("gpt-5.4-nano", true, RateCard{InputPerM: 0.2, OutputPerM: 1.25, CacheReadPerM: 0.02}),
	baseOnly("gpt-5.4-pro", true, RateCard{InputPerM: 30, OutputPerM: 180, CacheReadPerM: 3}),
	{
		BillingModel: "gpt-5.5",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 5, OutputPerM: 30, CacheReadPerM: 0.5}, TagMultipliers: map[string]float64{"fast": 2.5}},
		},
	},
	baseOnly("gpt-5.5-cyber", true, RateCard{InputPerM: 12.5, OutputPerM: 75, CacheReadPerM: 1.25}),
	baseOnly("gpt-5.5-pro", true, RateCard{InputPerM: 30, OutputPerM: 180, CacheReadPerM: 3}),
	{
		BillingModel: "gpt-5.6",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 5, OutputPerM: 30, CacheReadPerM: 0.5, CacheWritePerM: 6.25}, TagMultipliers: map[string]float64{"fast": 2}},
			{EffectiveFrom: "2026-08-22T09:39:36+08:00", Base: RateCard{InputPerM: 4, OutputPerM: 20, CacheReadPerM: 0.4, CacheWritePerM: 5, CacheWrite1hPerM: 10}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("gpt-5.6-cyber", true, RateCard{InputPerM: 12.5, OutputPerM: 75, CacheReadPerM: 1.25, CacheWritePerM: 15.625, CacheWrite1hPerM: 31.25}),
	{
		BillingModel: "gpt-5.6-luna",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.2, OutputPerM: 1.2, CacheReadPerM: 0.02, CacheWritePerM: 0.25, CacheWrite1hPerM: 0.5}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-5.6-sol",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 5, OutputPerM: 30, CacheReadPerM: 0.5, CacheWritePerM: 6.25}, TagMultipliers: map[string]float64{"fast": 2}},
			{EffectiveFrom: "2026-08-22T09:39:36+08:00", Base: RateCard{InputPerM: 4, OutputPerM: 20, CacheReadPerM: 0.4, CacheWritePerM: 5, CacheWrite1hPerM: 10}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-5.6-terra",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2, OutputPerM: 12, CacheReadPerM: 0.2, CacheWritePerM: 2.5, CacheWrite1hPerM: 5}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-6-astra",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 10, OutputPerM: 50, CacheReadPerM: 1, CacheWritePerM: 12.5, CacheWrite1hPerM: 25}, TagMultipliers: map[string]float64{"fast": 2, "ultrafast": 6}},
		},
	},
	baseOnly("gpt-6-cyber", true, RateCard{InputPerM: 20, OutputPerM: 100, CacheReadPerM: 2, CacheWritePerM: 25, CacheWrite1hPerM: 50}),
	{
		BillingModel: "gpt-6-luna",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.1, OutputPerM: 0.5, CacheReadPerM: 0.01, CacheWritePerM: 0.125, CacheWrite1hPerM: 0.25}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-6-rosalind",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 15, OutputPerM: 75, CacheReadPerM: 1.5, CacheWritePerM: 18.75}},
			{EffectiveFrom: "2026-11-18T23:02:05+08:00", Base: RateCard{InputPerM: 10, OutputPerM: 50, CacheReadPerM: 1, CacheWritePerM: 18.75}},
		},
	},
	{
		BillingModel: "gpt-6-sol",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.2, CacheWritePerM: 2.5, CacheWrite1hPerM: 5}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-6.1-sol",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.1, CacheWritePerM: 2.5, CacheWrite1hPerM: 5}, TagMultipliers: map[string]float64{"fast": 2, "ultrafast": 6}},
		},
	},
	{
		BillingModel: "gpt-6.1-terra",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1, OutputPerM: 5, CacheReadPerM: 0.05, CacheWritePerM: 1.25, CacheWrite1hPerM: 2.5}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-6.2-astra",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 8, OutputPerM: 40, CacheReadPerM: 0.4, CacheWritePerM: 10, CacheWrite1hPerM: 20}, TagMultipliers: map[string]float64{"fast": 2, "ultrafast": 3}},
			{EffectiveFrom: "2027-03-01", Base: RateCard{InputPerM: 8, OutputPerM: 40, CacheReadPerM: 0.4, CacheWritePerM: 10, CacheWrite1hPerM: 20}, TagMultipliers: map[string]float64{"fast": 2, "ultrafast": 6}},
		},
	},
	{
		BillingModel: "gpt-6.2-sol",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.1, CacheWritePerM: 2.5, CacheWrite1hPerM: 5}, TagMultipliers: map[string]float64{"fast": 2, "ultrafast": 3}},
			{EffectiveFrom: "2027-03-01", Base: RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.1, CacheWritePerM: 2.5, CacheWrite1hPerM: 5}, TagMultipliers: map[string]float64{"fast": 2, "ultrafast": 6}},
		},
	},
	baseOnly("gpt-daybreak-blue", true, RateCard{InputPerM: 4, OutputPerM: 20, CacheReadPerM: 0.4, CacheWritePerM: 5}),
	baseOnly("gpt-daybreak-red", true, RateCard{InputPerM: 12.5, OutputPerM: 75, CacheReadPerM: 1.25, CacheWritePerM: 15.625}),
	baseOnly("gpt-rosalind-discovery", true, RateCard{InputPerM: 5, OutputPerM: 25, CacheReadPerM: 0.5}),
	baseOnly("gpt-rosalind-research", true, RateCard{InputPerM: 5, OutputPerM: 25, CacheReadPerM: 0.5}),
	baseOnly("o1", false, RateCard{InputPerM: 15, OutputPerM: 60, CacheReadPerM: 7.5}),
	{
		BillingModel: "o1-mini",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 3, OutputPerM: 12}},
			{EffectiveFrom: "2025-02-01T05:30:06+08:00", Base: RateCard{InputPerM: 1.1, OutputPerM: 4.4, CacheReadPerM: 0.55}},
		},
	},
	baseOnly("o1-pro", true, RateCard{InputPerM: 150, OutputPerM: 600}),
	{
		BillingModel: "o3",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2, OutputPerM: 8, CacheReadPerM: 0.5}, TagMultipliers: map[string]float64{"fast": 1.75}},
		},
	},
	baseOnly("o3-mini", true, RateCard{InputPerM: 1.1, OutputPerM: 4.4, CacheReadPerM: 0.55}),
	baseOnly("o3-pro", true, RateCard{InputPerM: 20, OutputPerM: 80}),
	baseOnly("o4-mini", true, RateCard{InputPerM: 1.1, OutputPerM: 4.4, CacheReadPerM: 0.275}),
	{
		BillingModel: "gpt-6-terra",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1, OutputPerM: 5, CacheReadPerM: 0.05, CacheWritePerM: 1.25, CacheWrite1hPerM: 2.5}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-astra-latest",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 8, OutputPerM: 40, CacheReadPerM: 0.4, CacheWritePerM: 10, CacheWrite1hPerM: 20}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-sol-latest",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.1, CacheWritePerM: 2.5, CacheWrite1hPerM: 5}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-terra-latest",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1, OutputPerM: 5, CacheReadPerM: 0.05, CacheWritePerM: 1.25, CacheWrite1hPerM: 2.5}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	{
		BillingModel: "gpt-luna-latest",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.1, OutputPerM: 0.5, CacheReadPerM: 0.01, CacheWritePerM: 0.125, CacheWrite1hPerM: 0.25}, TagMultipliers: map[string]float64{"fast": 2}},
		},
	},
	baseOnly("gpt-5.5-mini", true, RateCard{InputPerM: 0.9, OutputPerM: 5.5, CacheReadPerM: 0.09}),
	baseOnly("codex-auto-review", true, RateCard{InputPerM: 0.2, OutputPerM: 1.2, CacheReadPerM: 0.02, CacheWritePerM: 0.25}),

	// Google Gemini / Gemma
	{
		BillingModel: "gemini-1.0-pro-vision",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.25, OutputPerM: 0.5}},
			{EffectiveFrom: "2025-02-01T13:12:05+08:00", Base: RateCard{InputPerM: 0.5, OutputPerM: 1.5}},
		},
	},
	baseOnly("gemini-1.5-flash", true, RateCard{InputPerM: 0.075, OutputPerM: 0.3}),
	baseOnly("gemini-1.5-flash-8b", true, RateCard{InputPerM: 0.0375, OutputPerM: 0.15}),
	baseOnly("gemini-1.5-pro", true, RateCard{InputPerM: 1.25, OutputPerM: 5}),
	{
		BillingModel: "gemini-2.0-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.1, OutputPerM: 0.4, CacheReadPerM: 0.025}},
			{EffectiveFrom: "2026-01-20T23:06:03+08:00", Base: RateCard{InputPerM: 0.15, OutputPerM: 0.6, CacheReadPerM: 0.025}},
		},
	},
	baseOnly("gemini-2.0-flash-lite", true, RateCard{InputPerM: 0.075, OutputPerM: 0.3}),
	baseOnly("gemini-2.5-flash", true, RateCard{InputPerM: 0.3, OutputPerM: 2.5, CacheReadPerM: 0.075}),
	baseOnly("gemini-2.5-flash-lite", true, RateCard{InputPerM: 0.1, OutputPerM: 0.4, CacheReadPerM: 0.025}),
	baseOnly("gemini-2.5-pro", true, RateCard{InputPerM: 1.25, OutputPerM: 10, CacheReadPerM: 0.31}),
	baseOnly("gemini-3-flash", true, RateCard{InputPerM: 0.5, OutputPerM: 3, CacheReadPerM: 0.05}),
	baseOnly("gemini-3-pro", true, RateCard{InputPerM: 2, OutputPerM: 12, CacheReadPerM: 0.2}),
	baseOnly("gemini-3.1-flash-lite", true, RateCard{InputPerM: 0.25, OutputPerM: 1.5, CacheReadPerM: 0.025}),
	baseOnly("gemini-3.1-flash-live", true, RateCard{InputPerM: 0.75, OutputPerM: 4.5}),
	baseOnly("gemini-3.1-pro", true, RateCard{InputPerM: 2, OutputPerM: 12, CacheReadPerM: 0.2}),
	baseOnly("gemini-3.5-flash", true, RateCard{InputPerM: 1.5, OutputPerM: 9, CacheReadPerM: 0.15}),
	baseOnly("gemini-3.5-flash-lite", true, RateCard{InputPerM: 0.3, OutputPerM: 2.5, CacheReadPerM: 0.03}),
	baseOnly("gemini-3.5-live-translate", true, RateCard{InputPerM: 3.5, OutputPerM: 21}),
	{
		BillingModel: "gemini-3.6-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.5, OutputPerM: 7.5, CacheReadPerM: 0.15}},
			{EffectiveFrom: "2026-08-21T00:10:48+08:00", Base: RateCard{InputPerM: 0.75, OutputPerM: 3.75, CacheReadPerM: 0.075}},
		},
	},
	baseOnly("gemini-3.7-flash", true, RateCard{InputPerM: 0.75, OutputPerM: 3.75, CacheReadPerM: 0.075}),
	baseOnly("gemini-3.8-flash", true, RateCard{InputPerM: 0.75, OutputPerM: 3.75, CacheReadPerM: 0.075}),
	baseOnly("gemini-3.8-live", true, RateCard{InputPerM: 0.75, OutputPerM: 4.5}),
	baseOnly("gemini-4-argon", true, RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.1}),
	baseOnly("gemini-4-carbon", true, RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.1}),
	baseOnly("gemini-4-hydrogen", true, RateCard{InputPerM: 1.5, OutputPerM: 7.5, CacheReadPerM: 0.075}),
	baseOnly("gemini-4-neon", true, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.15}),
	baseOnly("gemini-exp", true, RateCard{InputPerM: 0.3, OutputPerM: 2.5, CacheReadPerM: 0.03}),
	{
		BillingModel: "gemini-flash",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.3, OutputPerM: 2.5, CacheReadPerM: 0.075}},
			{EffectiveFrom: "2026-07-15T11:15:49+08:00", Base: RateCard{InputPerM: 1.5, OutputPerM: 9, CacheReadPerM: 0.15}},
			{EffectiveFrom: "2026-08-21T14:42:28+08:00", Base: RateCard{InputPerM: 0.75, OutputPerM: 3.75, CacheReadPerM: 0.075}},
		},
	},
	{
		BillingModel: "gemini-flash-lite",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.1, OutputPerM: 0.4, CacheReadPerM: 0.025}},
			{EffectiveFrom: "2026-07-15T11:15:49+08:00", Base: RateCard{InputPerM: 0.25, OutputPerM: 1.5, CacheReadPerM: 0.025}},
			{EffectiveFrom: "2026-08-21T14:42:28+08:00", Base: RateCard{InputPerM: 0.3, OutputPerM: 2.5, CacheReadPerM: 0.03}},
		},
	},
	baseOnly("gemini-live-2.5-flash", true, RateCard{InputPerM: 0.5, OutputPerM: 2}),
	{
		BillingModel: "gemini-nano-banana-2.1",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.5, OutputPerM: 30, CacheReadPerM: 0.15}},
			{EffectiveFrom: "2026-11-16T06:57:01+08:00", Base: RateCard{InputPerM: 1.5, OutputPerM: 7.5, CacheReadPerM: 0.15}},
		},
	},
	{
		BillingModel: "gemini-omni-1.1-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.5, OutputPerM: 17.5}},
			{EffectiveFrom: "2026-11-24T01:27:25+08:00", Base: RateCard{InputPerM: 1.5, OutputPerM: 9}},
		},
	},
	{
		BillingModel: "gemini-omni-1.2-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1.5, OutputPerM: 12}},
			{EffectiveFrom: "2026-11-24T01:27:25+08:00", Base: RateCard{InputPerM: 1.5, OutputPerM: 9}},
		},
	},
	baseOnly("gemini-omni-flash", true, RateCard{InputPerM: 1.5, OutputPerM: 17.5}),
	baseOnly("gemini-pro", false, RateCard{InputPerM: 2, OutputPerM: 8}),
	{
		BillingModel: "gemini-pro-vision",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.25, OutputPerM: 0.5}},
			{EffectiveFrom: "2025-02-01T13:12:05+08:00", Base: RateCard{InputPerM: 0.5, OutputPerM: 1.5}},
		},
	},
	baseOnly("gemini-robotics-er-1.5", true, RateCard{InputPerM: 0.3, OutputPerM: 2.5}),
	baseOnly("gemini-robotics-er-1.6", true, RateCard{InputPerM: 1, OutputPerM: 5}),
	baseOnly("gemini-robotics-er-2", true, RateCard{InputPerM: 1, OutputPerM: 5, CacheReadPerM: 0.1}),
	baseOnly("gemini-robotics-er-2-streaming", true, RateCard{InputPerM: 1, OutputPerM: 5}),
	baseOnly("gemini-ultra", false, RateCard{InputPerM: 2, OutputPerM: 8}),
	baseOnly("gemma-4-26b-a4b-it-maas", true, RateCard{InputPerM: 0.15, OutputPerM: 0.6, CacheReadPerM: 0.015}),
	baseOnly("gemini-3.8-flash-cyber", true, RateCard{InputPerM: 1.5, OutputPerM: 7.5, CacheReadPerM: 0.15}),
	baseOnly("gemini-3.1-flash", true, RateCard{InputPerM: 0.5, OutputPerM: 3, CacheReadPerM: 0.05}),

	// DeepSeek
	{
		BillingModel: "deepseek-chat",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.14, OutputPerM: 0.28, CacheReadPerM: 0.028}},
			{EffectiveFrom: "2025-08-24T05:44:56+08:00", Base: RateCard{InputPerM: 0.57, OutputPerM: 1.68, CacheReadPerM: 0.07}},
			{EffectiveFrom: "2025-11-17T23:53:39+08:00", Base: RateCard{InputPerM: 0.28, OutputPerM: 0.42, CacheReadPerM: 0.028}},
		},
	},
	baseOnly("deepseek-coder", false, RateCard{InputPerM: 0.14, OutputPerM: 0.28}),
	{
		BillingModel: "deepseek-reasoner",
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.55, OutputPerM: 2.19}},
			{EffectiveFrom: "2025-08-24T05:44:56+08:00", Base: RateCard{InputPerM: 0.57, OutputPerM: 1.68, CacheReadPerM: 0.07}},
			{EffectiveFrom: "2025-11-17T23:53:39+08:00", Base: RateCard{InputPerM: 0.28, OutputPerM: 0.42, CacheReadPerM: 0.028}},
			{EffectiveFrom: "2026-04-25T18:57:29+08:00", Base: RateCard{InputPerM: 0.14, OutputPerM: 0.28, CacheReadPerM: 0.028}},
		},
	},
	baseOnly("deepseek-v3.2", true, RateCard{InputPerM: 0.28, OutputPerM: 0.42}),
	{
		BillingModel: "deepseek-v4-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.14, OutputPerM: 0.28, CacheReadPerM: 0.028}},
			{EffectiveFrom: "2026-09-11T00:10:24+08:00", Base: RateCard{InputPerM: 0.15, OutputPerM: 0.6, CacheReadPerM: 0.003}, TagMultipliers: map[string]float64{"peak": 2}},
		},
	},
	{
		BillingModel: "deepseek-v4-pro",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.435, OutputPerM: 0.87, CacheReadPerM: 0.003625}},
			{EffectiveFrom: "2026-10-03T00:20:50+08:00", Base: RateCard{InputPerM: 0.66, OutputPerM: 1.98, CacheReadPerM: 0.022}, TagMultipliers: map[string]float64{"peak": 2}},
		},
	},
	baseOnly("deepseek-v4.1-flash", true, RateCard{InputPerM: 0.15, OutputPerM: 0.6, CacheReadPerM: 0.003}),
	{
		BillingModel: "deepseek-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.15, OutputPerM: 0.6, CacheReadPerM: 0.003}, TagMultipliers: map[string]float64{"peak": 2}},
		},
	},
	{
		BillingModel: "deepseek-v4",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.435, OutputPerM: 0.87, CacheReadPerM: 0.003625}},
			{EffectiveFrom: "2026-10-03T06:06:15+08:00", Base: RateCard{InputPerM: 0.66, OutputPerM: 1.98, CacheReadPerM: 0.022}, TagMultipliers: map[string]float64{"peak": 2}},
		},
	},
	baseOnly("deepseek-r1", true, RateCard{InputPerM: 0.55, OutputPerM: 2.19, CacheReadPerM: 0.14}),
	baseOnly("deepseek-v3", true, RateCard{InputPerM: 0.27, OutputPerM: 1.1, CacheReadPerM: 0.07}),

	// Alibaba Qwen
	baseOnly("qwen-flash", true, RateCard{InputPerM: 0.05, OutputPerM: 0.4, CacheReadPerM: 0.01}),
	baseOnly("qwen-max", true, RateCard{InputPerM: 1.6, OutputPerM: 6.4, CacheReadPerM: 0.32}),
	baseOnly("qwen-mt-plus", true, RateCard{InputPerM: 2.46, OutputPerM: 7.37}),
	baseOnly("qwen-mt-turbo", true, RateCard{InputPerM: 0.16, OutputPerM: 0.49}),
	baseOnly("qwen-omni-turbo", true, RateCard{InputPerM: 0.07, OutputPerM: 0.27}),
	baseOnly("qwen-plus", true, RateCard{InputPerM: 0.4, OutputPerM: 1.2, CacheReadPerM: 0.08}),
	baseOnly("qwen-plus-character-ja", true, RateCard{InputPerM: 0.5, OutputPerM: 1.4, CacheReadPerM: 0.1}),
	baseOnly("qwen-turbo", true, RateCard{InputPerM: 0.05, OutputPerM: 0.2}),
	baseOnly("qwen-vl-max", true, RateCard{InputPerM: 0.8, OutputPerM: 3.2}),
	{
		BillingModel: "qwen-vl-ocr",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.72, OutputPerM: 0.72}},
			{EffectiveFrom: "2026-10-07T23:06:43+08:00", Base: RateCard{InputPerM: 0.07, OutputPerM: 0.16}},
		},
	},
	baseOnly("qwen-vl-plus", true, RateCard{InputPerM: 0.21, OutputPerM: 0.63}),
	baseOnly("qwen2-5-14b-instruct", true, RateCard{InputPerM: 0.35, OutputPerM: 1.4}),
	baseOnly("qwen2-5-32b-instruct", true, RateCard{InputPerM: 0.7, OutputPerM: 2.8}),
	baseOnly("qwen2-5-72b-instruct", true, RateCard{InputPerM: 1.4, OutputPerM: 5.6}),
	baseOnly("qwen2-5-7b-instruct", true, RateCard{InputPerM: 0.175, OutputPerM: 0.7}),
	baseOnly("qwen2-5-omni-7b", true, RateCard{InputPerM: 0.1, OutputPerM: 0.4}),
	baseOnly("qwen2-5-vl-72b-instruct", true, RateCard{InputPerM: 2.8, OutputPerM: 8.4}),
	baseOnly("qwen2-5-vl-7b-instruct", true, RateCard{InputPerM: 0.35, OutputPerM: 1.05}),
	baseOnly("qwen3-14b", true, RateCard{InputPerM: 0.35, OutputPerM: 1.4}),
	baseOnly("qwen3-235b-a22b", true, RateCard{InputPerM: 0.7, OutputPerM: 2.8}),
	baseOnly("qwen3-32b", true, RateCard{InputPerM: 0.7, OutputPerM: 2.8}),
	baseOnly("qwen3-8b", true, RateCard{InputPerM: 0.18, OutputPerM: 0.7}),
	baseOnly("qwen3-asr-flash", true, RateCard{InputPerM: 0.035, OutputPerM: 0.035}),
	baseOnly("qwen3-coder-30b-a3b-instruct", true, RateCard{InputPerM: 0.45, OutputPerM: 2.25}),
	baseOnly("qwen3-coder-480b-a35b-instruct", true, RateCard{InputPerM: 1.5, OutputPerM: 7.5}),
	baseOnly("qwen3-coder-flash", true, RateCard{InputPerM: 0.3, OutputPerM: 1.5, CacheReadPerM: 0.06}),
	baseOnly("qwen3-coder-plus", true, RateCard{InputPerM: 1, OutputPerM: 5}),
	baseOnly("qwen3-max", true, RateCard{InputPerM: 1.2, OutputPerM: 6}),
	baseOnly("qwen3-next-80b-a3b", true, RateCard{InputPerM: 0.5, OutputPerM: 6}),
	baseOnly("qwen3-next-80b-a3b-instruct", true, RateCard{InputPerM: 0.5, OutputPerM: 2}),
	baseOnly("qwen3-omni-flash", true, RateCard{InputPerM: 0.43, OutputPerM: 1.66}),
	baseOnly("qwen3-vl-235b-a22b", true, RateCard{InputPerM: 0.7, OutputPerM: 2.8}),
	baseOnly("qwen3-vl-30b-a3b", true, RateCard{InputPerM: 0.2, OutputPerM: 0.8}),
	baseOnly("qwen3-vl-plus", true, RateCard{InputPerM: 0.2, OutputPerM: 1.6, CacheReadPerM: 0.04}),
	baseOnly("qwen3.5-122b-a10b", true, RateCard{InputPerM: 0.4, OutputPerM: 3.2}),
	baseOnly("qwen3.5-27b", true, RateCard{InputPerM: 0.3, OutputPerM: 2.4}),
	baseOnly("qwen3.5-35b-a3b", true, RateCard{InputPerM: 0.25, OutputPerM: 2}),
	baseOnly("qwen3.5-397b-a17b", true, RateCard{InputPerM: 0.6, OutputPerM: 3.6}),
	baseOnly("qwen3.5-flash", true, RateCard{InputPerM: 0.1, OutputPerM: 0.4, CacheReadPerM: 0.01}),
	baseOnly("qwen3.5-plus", true, RateCard{InputPerM: 0.4, OutputPerM: 2.4}),
	baseOnly("qwen3.6-27b", true, RateCard{InputPerM: 0.6, OutputPerM: 3.6}),
	{
		BillingModel: "qwen3.6-35b-a3b",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.248, OutputPerM: 1.485}},
			{EffectiveFrom: "2026-10-20T11:35:36+08:00", Base: RateCard{InputPerM: 0.375, OutputPerM: 2.25}},
		},
	},
	{
		BillingModel: "qwen3.6-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.1875, OutputPerM: 1.125}},
			{EffectiveFrom: "2026-10-20T11:35:36+08:00", Base: RateCard{InputPerM: 0.25, OutputPerM: 1.5, CacheReadPerM: 0.025}},
		},
	},
	baseOnly("qwen3.6-max", true, RateCard{InputPerM: 1.3, OutputPerM: 7.8, CacheReadPerM: 0.13}),
	{
		BillingModel: "qwen3.6-plus",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.276, OutputPerM: 1.651, CacheReadPerM: 0.028}},
			{EffectiveFrom: "2026-05-12T05:11:19+08:00", Base: RateCard{InputPerM: 0.5, OutputPerM: 3, CacheReadPerM: 0.05}},
		},
	},
	baseOnly("qwen3.7-flash", true, RateCard{InputPerM: 0.03, OutputPerM: 0.13, CacheReadPerM: 0.003}),
	baseOnly("qwen3.7-max", true, RateCard{InputPerM: 2.5, OutputPerM: 7.5, CacheReadPerM: 0.5}),
	{
		BillingModel: "qwen3.7-plus",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.5, OutputPerM: 3, CacheReadPerM: 0.05}},
			{EffectiveFrom: "2026-09-28T12:01:19+08:00", Base: RateCard{InputPerM: 0.4, OutputPerM: 1.6, CacheReadPerM: 0.04}},
		},
	},
	baseOnly("qwen3.8-2.4t-a95b", true, RateCard{InputPerM: 2, OutputPerM: 6, CacheReadPerM: 0.25}),
	baseOnly("qwen3.8-27b", true, RateCard{InputPerM: 0.5, OutputPerM: 3, CacheReadPerM: 0.1}),
	baseOnly("qwen3.8-flash", true, RateCard{InputPerM: 0.15, OutputPerM: 0.47, CacheReadPerM: 0.016}),
	baseOnly("qwen3.8-max", true, RateCard{InputPerM: 2, OutputPerM: 6, CacheReadPerM: 0.25}),
	baseOnly("qwen3.8-omni-flash", true, RateCard{InputPerM: 0.15, OutputPerM: 0.47, CacheReadPerM: 0.016}),
	baseOnly("qwen4-max", true, RateCard{InputPerM: 1.5, OutputPerM: 4.5, CacheReadPerM: 0.075}),
	baseOnly("qwen3-coder", true, RateCard{InputPerM: 0.3, OutputPerM: 1.5, CacheReadPerM: 0.03}),
	baseOnly("qwen3-plus", true, RateCard{InputPerM: 0.4, OutputPerM: 1.6, CacheReadPerM: 0.04}),
	baseOnly("qwen3.5", true, RateCard{InputPerM: 0.4, OutputPerM: 1.6, CacheReadPerM: 0.04}),

	// Zhipu GLM
	baseOnly("glm-4-32b-0414-128k", true, RateCard{InputPerM: 0.1, OutputPerM: 0.1}),
	baseOnly("glm-4.5", true, RateCard{InputPerM: 0.6, OutputPerM: 2.2, CacheReadPerM: 0.11}),
	baseOnly("glm-4.5-air", true, RateCard{InputPerM: 0.2, OutputPerM: 1.1, CacheReadPerM: 0.03}),
	baseOnly("glm-4.5-airx", true, RateCard{InputPerM: 1.1, OutputPerM: 4.5, CacheReadPerM: 0.22}),
	baseOnly("glm-4.5-x", true, RateCard{InputPerM: 2.2, OutputPerM: 8.9, CacheReadPerM: 0.45}),
	baseOnly("glm-4.5v", true, RateCard{InputPerM: 0.6, OutputPerM: 1.8, CacheReadPerM: 0.11}),
	baseOnly("glm-4.6", true, RateCard{InputPerM: 0.6, OutputPerM: 2.2, CacheReadPerM: 0.11}),
	baseOnly("glm-4.6v", true, RateCard{InputPerM: 0.3, OutputPerM: 0.9, CacheReadPerM: 0.05}),
	baseOnly("glm-4.6v-flashx", true, RateCard{InputPerM: 0.04, OutputPerM: 0.4, CacheReadPerM: 0.004}),
	baseOnly("glm-4.7", true, RateCard{InputPerM: 0.6, OutputPerM: 2.2, CacheReadPerM: 0.11}),
	baseOnly("glm-4.7-flashx", true, RateCard{InputPerM: 0.07, OutputPerM: 0.4, CacheReadPerM: 0.01}),
	baseOnly("glm-5", true, RateCard{InputPerM: 1, OutputPerM: 3.2, CacheReadPerM: 0.2}),
	baseOnly("glm-5-turbo", true, RateCard{InputPerM: 1.2, OutputPerM: 4, CacheReadPerM: 0.24}),
	baseOnly("glm-5.1", true, RateCard{InputPerM: 1.4, OutputPerM: 4.4, CacheReadPerM: 0.26}),
	baseOnly("glm-5.2", true, RateCard{InputPerM: 1.4, OutputPerM: 4.4, CacheReadPerM: 0.26}),
	baseOnly("glm-5.3", true, RateCard{InputPerM: 1.4, OutputPerM: 4.4, CacheReadPerM: 0.26}),
	{
		BillingModel: "glm-5.3-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.075, OutputPerM: 0.25, CacheReadPerM: 0.015}},
			{EffectiveFrom: "2026-09-19T13:17:06+08:00", Base: RateCard{InputPerM: 0.15, OutputPerM: 0.5, CacheReadPerM: 0.03}},
		},
	},
	baseOnly("glm-5.3-flashx", true, RateCard{InputPerM: 0.37, OutputPerM: 1.25, CacheReadPerM: 0.075}),
	baseOnly("glm-5v-turbo", true, RateCard{InputPerM: 1.2, OutputPerM: 4, CacheReadPerM: 0.24}),
	baseOnly("glm-4.7-flash", true, RateCard{InputPerM: 0, OutputPerM: 0}),

	// Moonshot Kimi
	baseOnly("kimi-k2", true, RateCard{InputPerM: 0.6, OutputPerM: 2.5, CacheReadPerM: 0.15}),
	baseOnly("kimi-k2-thinking-turbo", true, RateCard{InputPerM: 1.15, OutputPerM: 8, CacheReadPerM: 0.15}),
	baseOnly("kimi-k2-turbo", true, RateCard{InputPerM: 2.4, OutputPerM: 10, CacheReadPerM: 0.6}),
	baseOnly("kimi-k2.5", true, RateCard{InputPerM: 0.6, OutputPerM: 3, CacheReadPerM: 0.1}),
	baseOnly("kimi-k2.6", true, RateCard{InputPerM: 0.95, OutputPerM: 4, CacheReadPerM: 0.16}),
	baseOnly("kimi-k2.7-code", true, RateCard{InputPerM: 0.95, OutputPerM: 4, CacheReadPerM: 0.19}),
	baseOnly("kimi-k2.7-code-highspeed", true, RateCard{InputPerM: 1.9, OutputPerM: 8, CacheReadPerM: 0.38}),
	baseOnly("kimi-k3", true, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.3, CacheWritePerM: 3, CacheWrite1hPerM: 6}),
	baseOnly("kimi-k3.1-pro", true, RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.2, CacheWritePerM: 2, CacheWrite1hPerM: 4}),
	baseOnly("kimi-k3.1-pro-highspeed", true, RateCard{InputPerM: 4, OutputPerM: 20, CacheReadPerM: 0.2, CacheWritePerM: 4, CacheWrite1hPerM: 8}),
	baseOnly("kimi-k3.1", true, RateCard{InputPerM: 2, OutputPerM: 10, CacheReadPerM: 0.2, CacheWritePerM: 2, CacheWrite1hPerM: 4}),
	baseOnly("kimi-k2.7", true, RateCard{InputPerM: 0.95, OutputPerM: 4, CacheReadPerM: 0.19}),
	baseOnly("kimi-for-coding", true, RateCard{InputPerM: 0.6, OutputPerM: 2.5, CacheReadPerM: 0.15}),

	// MiniMax
	baseOnly("minimax-m2", true, RateCard{InputPerM: 0.3, OutputPerM: 1.2}),
	baseOnly("minimax-m2.1", true, RateCard{InputPerM: 0.3, OutputPerM: 1.2, CacheReadPerM: 0.03, CacheWritePerM: 0.375}),
	baseOnly("minimax-m2.5", true, RateCard{InputPerM: 0.3, OutputPerM: 1.2, CacheReadPerM: 0.03, CacheWritePerM: 0.375}),
	baseOnly("minimax-m2.5-highspeed", true, RateCard{InputPerM: 0.6, OutputPerM: 2.4, CacheReadPerM: 0.06, CacheWritePerM: 0.375}),
	baseOnly("minimax-m2.7", true, RateCard{InputPerM: 0.3, OutputPerM: 1.2, CacheReadPerM: 0.03, CacheWritePerM: 0.375}),
	baseOnly("minimax-m2.7-highspeed", true, RateCard{InputPerM: 0.6, OutputPerM: 2.4, CacheReadPerM: 0.06, CacheWritePerM: 0.375}),
	baseOnly("minimax-m3", true, RateCard{InputPerM: 0.3, OutputPerM: 1.2, CacheReadPerM: 0.06}),
	baseOnly("minimax-m3.1-flash", true, RateCard{InputPerM: 0.15, OutputPerM: 0.6, CacheReadPerM: 0.015}),

	// xAI Grok
	baseOnly("grok-2", false, RateCard{InputPerM: 2, OutputPerM: 10}),
	baseOnly("grok-2-vision", true, RateCard{InputPerM: 2, OutputPerM: 10}),
	baseOnly("grok-3", false, RateCard{InputPerM: 3, OutputPerM: 15}),
	baseOnly("grok-3-fast", true, RateCard{InputPerM: 5, OutputPerM: 25}),
	baseOnly("grok-3-mini", true, RateCard{InputPerM: 0.3, OutputPerM: 0.5}),
	baseOnly("grok-3-mini-fast", true, RateCard{InputPerM: 0.6, OutputPerM: 4}),
	baseOnly("grok-4", false, RateCard{InputPerM: 3, OutputPerM: 15, CacheReadPerM: 0.75}),
	baseOnly("grok-4-fast", true, RateCard{InputPerM: 0.2, OutputPerM: 0.5, CacheReadPerM: 0.05}),
	baseOnly("grok-4.1-fast", true, RateCard{InputPerM: 0.2, OutputPerM: 0.5, CacheReadPerM: 0.05}),
	{
		BillingModel: "grok-4.20",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 2, OutputPerM: 6, CacheReadPerM: 0.2}},
			{EffectiveFrom: "2026-05-21T02:23:02+08:00", Base: RateCard{InputPerM: 1.25, OutputPerM: 2.5, CacheReadPerM: 0.2}},
		},
	},
	baseOnly("grok-4.3", true, RateCard{InputPerM: 1.25, OutputPerM: 2.5, CacheReadPerM: 0.2}),
	baseOnly("grok-4.5", true, RateCard{InputPerM: 2, OutputPerM: 6, CacheReadPerM: 0.5}),
	baseOnly("grok-4.6", true, RateCard{InputPerM: 2, OutputPerM: 6, CacheReadPerM: 0.5}),
	baseOnly("grok-4.7", true, RateCard{InputPerM: 2, OutputPerM: 6, CacheReadPerM: 0.5}),
	baseOnly("grok-beta", true, RateCard{InputPerM: 5, OutputPerM: 15}),
	baseOnly("grok-build-0.1", true, RateCard{InputPerM: 1, OutputPerM: 2, CacheReadPerM: 0.2}),
	baseOnly("grok-code-fast-1", true, RateCard{InputPerM: 0.2, OutputPerM: 1.5, CacheReadPerM: 0.02}),
	baseOnly("grok-vision", true, RateCard{InputPerM: 5, OutputPerM: 15}),
	baseOnly("grok-code-fast", true, RateCard{InputPerM: 0.2, OutputPerM: 1.5, CacheReadPerM: 0.02}),
	baseOnly("grok-build", true, RateCard{InputPerM: 1, OutputPerM: 2, CacheReadPerM: 0.2}),

	// Xiaomi MiMo
	{
		BillingModel: "mimo-v2-flash",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.07, OutputPerM: 0.21}},
			{EffectiveFrom: "2026-02-27T14:56:16+08:00", Base: RateCard{InputPerM: 0.1, OutputPerM: 0.3, CacheReadPerM: 0.01}},
			{EffectiveFrom: "2026-06-29T14:09:26+08:00", Base: RateCard{InputPerM: 0.14, OutputPerM: 0.28, CacheReadPerM: 0.0028}},
		},
	},
	{
		BillingModel: "mimo-v2-omni",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.4, OutputPerM: 2, CacheReadPerM: 0.08}},
			{EffectiveFrom: "2026-06-29T14:09:26+08:00", Base: RateCard{InputPerM: 0.14, OutputPerM: 0.28, CacheReadPerM: 0.0028}},
		},
	},
	{
		BillingModel: "mimo-v2-pro",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1, OutputPerM: 3, CacheReadPerM: 0.2}},
			{EffectiveFrom: "2026-06-29T14:09:26+08:00", Base: RateCard{InputPerM: 0.435, OutputPerM: 0.87, CacheReadPerM: 0.0036}},
		},
	},
	{
		BillingModel: "mimo-v2.5",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 0.4, OutputPerM: 2, CacheReadPerM: 0.08}},
			{EffectiveFrom: "2026-06-29T14:09:26+08:00", Base: RateCard{InputPerM: 0.14, OutputPerM: 0.28, CacheReadPerM: 0.0028}},
		},
	},
	{
		BillingModel: "mimo-v2.5-pro",
		MatchPrefix:  true,
		Versions: []PriceVersion{
			{Base: RateCard{InputPerM: 1, OutputPerM: 3, CacheReadPerM: 0.2}},
			{EffectiveFrom: "2026-06-29T14:09:26+08:00", Base: RateCard{InputPerM: 0.435, OutputPerM: 0.87, CacheReadPerM: 0.0036}},
		},
	},
	baseOnly("mimo-v2.5-pro-ultraspeed", true, RateCard{InputPerM: 1.305, OutputPerM: 2.61, CacheReadPerM: 0.0108}),
	baseOnly("mimo-v2.6-flash", true, RateCard{InputPerM: 0.14, OutputPerM: 0.28, CacheReadPerM: 0.0028}),
	baseOnly("mimo-v2.6-pro", true, RateCard{InputPerM: 0.435, OutputPerM: 0.87, CacheReadPerM: 0.0036}),
	baseOnly("mimo-v2.6-pro-ultraspeed", true, RateCard{InputPerM: 4.35, OutputPerM: 8.7, CacheReadPerM: 0.036}),

	// StepFun
	baseOnly("step-1-32k", true, RateCard{InputPerM: 2.05, OutputPerM: 9.59, CacheReadPerM: 0.41}),
	baseOnly("step-1o-turbo-vision", true, RateCard{InputPerM: 0.37429, OutputPerM: 1.1977, CacheReadPerM: 0.074858}),
	baseOnly("step-2-16k", true, RateCard{InputPerM: 5.21, OutputPerM: 16.44, CacheReadPerM: 1.04}),
	baseOnly("step-3.5-flash", true, RateCard{InputPerM: 0.10461, OutputPerM: 0.31384, CacheReadPerM: 0.02092}),
	baseOnly("step-3.7-flash", true, RateCard{InputPerM: 0.2, OutputPerM: 1.15, CacheReadPerM: 0.04}),
	baseOnly("step-5", true, RateCard{InputPerM: 1.04613, OutputPerM: 2.98895, CacheReadPerM: 0.10461}),
}
