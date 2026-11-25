package ai_usage

import (
	"regexp"
	"sort"
	"strings"
)

var (
	reDateSuffix = regexp.MustCompile(`(?:[-@](?:20\d{6}|20\d{2}-\d{2}-\d{2})|-v\d+:\d+)$`)
	providerPrefixes = []string{
		"us.anthropic.",
		"eu.anthropic.",
		"apac.anthropic.",
		"global.anthropic.",
		"anthropic/",
		"openai/",
		"google/",
		"vertex_ai/",
		"bedrock/",
		"openrouter/",
		"deepseek/",
		"x-ai/",
		"models/",
	}
)

type builtinAliasRule struct {
	pattern   string
	canonical string
}

var builtinAliasRules = []builtinAliasRule{
	{pattern: "claude-opus-4-6*", canonical: "claude-opus-4.6"},
	{pattern: "claude-4-6-opus*", canonical: "claude-opus-4.6"},
	{pattern: "claude-4.6-opus*", canonical: "claude-opus-4.6"},
	{pattern: "claude-sonnet-4-6*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-4-6-sonnet*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-4.6-sonnet*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-opus-4-5*", canonical: "claude-opus-4.5"},
	{pattern: "claude-4-5-opus*", canonical: "claude-opus-4.5"},
	{pattern: "claude-4.5-opus*", canonical: "claude-opus-4.5"},
	{pattern: "claude-sonnet-4-5*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-4-5-sonnet*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-4.5-sonnet*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-haiku-4-5*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-4-5-haiku*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-4.5-haiku*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-opus-4-1*", canonical: "claude-opus-4.1"},
	{pattern: "claude-opus-4*", canonical: "claude-opus-4"},
	{pattern: "claude-sonnet-4*", canonical: "claude-sonnet-4"},
	{pattern: "claude-3-7-sonnet*", canonical: "claude-3.7-sonnet"},
	{pattern: "claude-3-5-sonnet*", canonical: "claude-3.5-sonnet"},
	{pattern: "claude-3-5-haiku*", canonical: "claude-3.5-haiku"},
}

// builtinModelPrices holds default USD prices per 1M tokens for popular coding models.
var builtinModelPrices = []ModelPrice{
	// Anthropic Claude
	{ModelPattern: "claude-opus-4.6", InputPerM: 5.00, OutputPerM: 25.00, CacheReadPerM: 0.50, CacheWritePerM: 6.25, CacheWrite1hPerM: 10.00, Builtin: true},
	{ModelPattern: "claude-opus-4.5", InputPerM: 5.00, OutputPerM: 25.00, CacheReadPerM: 0.50, CacheWritePerM: 6.25, CacheWrite1hPerM: 10.00, Builtin: true},
	{ModelPattern: "claude-opus-4.1", InputPerM: 15.00, OutputPerM: 75.00, CacheReadPerM: 1.50, CacheWritePerM: 18.75, CacheWrite1hPerM: 30.00, Builtin: true},
	{ModelPattern: "claude-opus-4", InputPerM: 15.00, OutputPerM: 75.00, CacheReadPerM: 1.50, CacheWritePerM: 18.75, CacheWrite1hPerM: 30.00, Builtin: true},
	{ModelPattern: "claude-sonnet-4.6", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-sonnet-4.5", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-sonnet-4", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-3.7-sonnet", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-3.5-sonnet", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-haiku-4.5", InputPerM: 1.00, OutputPerM: 5.00, CacheReadPerM: 0.10, CacheWritePerM: 1.25, CacheWrite1hPerM: 2.00, Builtin: true},
	{ModelPattern: "claude-3.5-haiku", InputPerM: 0.80, OutputPerM: 4.00, CacheReadPerM: 0.08, CacheWritePerM: 1.00, CacheWrite1hPerM: 1.60, Builtin: true},

	// OpenAI GPT / Codex / o-series
	{ModelPattern: "gpt-5.4", InputPerM: 2.50, OutputPerM: 15.00, CacheReadPerM: 0.25, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.3-codex", InputPerM: 1.75, OutputPerM: 14.00, CacheReadPerM: 0.175, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.2-codex", InputPerM: 1.75, OutputPerM: 14.00, CacheReadPerM: 0.175, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.2", InputPerM: 1.75, OutputPerM: 14.00, CacheReadPerM: 0.175, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.1-codex*", InputPerM: 1.25, OutputPerM: 10.00, CacheReadPerM: 0.125, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5-codex*", InputPerM: 1.25, OutputPerM: 10.00, CacheReadPerM: 0.125, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5-mini*", InputPerM: 0.25, OutputPerM: 2.00, CacheReadPerM: 0.025, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5*", InputPerM: 1.25, OutputPerM: 10.00, CacheReadPerM: 0.125, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-4.1-mini*", InputPerM: 0.40, OutputPerM: 1.60, CacheReadPerM: 0.10, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-4.1*", InputPerM: 2.00, OutputPerM: 8.00, CacheReadPerM: 0.50, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "o3*", InputPerM: 2.00, OutputPerM: 8.00, CacheReadPerM: 0.50, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "o4-mini*", InputPerM: 1.10, OutputPerM: 4.40, CacheReadPerM: 0.275, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// Google Gemini
	{ModelPattern: "gemini-3.1-pro*", InputPerM: 2.00, OutputPerM: 12.00, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3-pro*", InputPerM: 2.00, OutputPerM: 12.00, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3-flash*", InputPerM: 0.50, OutputPerM: 3.00, CacheReadPerM: 0.05, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-2.5-pro*", InputPerM: 1.25, OutputPerM: 10.00, CacheReadPerM: 0.125, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-2.5-flash*", InputPerM: 0.30, OutputPerM: 2.50, CacheReadPerM: 0.03, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// DeepSeek
	{ModelPattern: "deepseek-reasoner*", InputPerM: 0.55, OutputPerM: 2.19, CacheReadPerM: 0.14, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-r1*", InputPerM: 0.55, OutputPerM: 2.19, CacheReadPerM: 0.14, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-chat*", InputPerM: 0.27, OutputPerM: 1.10, CacheReadPerM: 0.07, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-v3*", InputPerM: 0.27, OutputPerM: 1.10, CacheReadPerM: 0.07, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
}

func DefaultModelPrices() []ModelPrice {
	out := make([]ModelPrice, len(builtinModelPrices))
	copy(out, builtinModelPrices)
	return out
}

// MatchPattern performs case-insensitive glob matching supporting '*' wildcards.
func MatchPattern(pattern, target string) bool {
	p := strings.ToLower(strings.TrimSpace(pattern))
	s := strings.ToLower(strings.TrimSpace(target))
	if p == "" {
		return false
	}
	if p == "*" || p == s {
		return true
	}
	parts := strings.Split(p, "*")
	if len(parts) == 1 {
		return p == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	last := parts[len(parts)-1]
	if !strings.HasSuffix(s, last) {
		return false
	}
	s = s[:len(s)-len(last)]
	for _, mid := range parts[1 : len(parts)-1] {
		if mid == "" {
			continue
		}
		idx := strings.Index(s, mid)
		if idx < 0 {
			return false
		}
		s = s[idx+len(mid):]
	}
	return true
}

// NormalizeModel resolves a raw model name via user aliases first, then built-in normalization rules.
func NormalizeModel(raw string, userAliases []ModelAlias) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "unknown"
	}

	// 1. User custom aliases take top priority (already ordered by priority ASC, id ASC).
	for _, a := range userAliases {
		if MatchPattern(a.MatchPattern, trimmed) {
			if canon := strings.TrimSpace(a.CanonicalModel); canon != "" {
				return canon
			}
		}
	}

	// 2. Strip common provider prefixes and trailing date/version tags.
	cleaned := strings.ToLower(trimmed)
	for _, pfx := range providerPrefixes {
		if strings.HasPrefix(cleaned, pfx) {
			cleaned = strings.TrimPrefix(cleaned, pfx)
			break
		}
	}
	cleaned = reDateSuffix.ReplaceAllString(cleaned, "")

	// Re-check user aliases against stripped name as well.
	for _, a := range userAliases {
		if MatchPattern(a.MatchPattern, cleaned) {
			if canon := strings.TrimSpace(a.CanonicalModel); canon != "" {
				return canon
			}
		}
	}

	// 3. Built-in family canonicalization.
	for _, rule := range builtinAliasRules {
		if MatchPattern(rule.pattern, cleaned) {
			return rule.canonical
		}
	}
	return cleaned
}

// ResolvePrice finds the best matching price entry: user custom prices first, then built-in table.
func ResolvePrice(rawModel, canonicalModel string, userPrices []ModelPrice) (ModelPrice, bool) {
	// Check exact user overrides first, then wildcard user overrides (longer pattern first).
	ordered := make([]ModelPrice, len(userPrices))
	copy(ordered, userPrices)
	sort.SliceStable(ordered, func(i, j int) bool {
		wi := strings.Contains(ordered[i].ModelPattern, "*")
		wj := strings.Contains(ordered[j].ModelPattern, "*")
		if wi != wj {
			return !wi
		}
		return len(ordered[i].ModelPattern) > len(ordered[j].ModelPattern)
	})
	for _, p := range ordered {
		if MatchPattern(p.ModelPattern, canonicalModel) || MatchPattern(p.ModelPattern, rawModel) {
			return p, true
		}
	}
	for _, p := range builtinModelPrices {
		if MatchPattern(p.ModelPattern, canonicalModel) || MatchPattern(p.ModelPattern, rawModel) {
			return p, true
		}
	}
	return ModelPrice{}, false
}

// ComputeCost calculates equivalent USD cost and cache savings for one slice.
func ComputeCost(row HourlySessionRecord, canonicalModel string, userPrices []ModelPrice) (costUSD float64, cacheSavingsUSD float64) {
	price, ok := ResolvePrice(row.Model, canonicalModel, userPrices)
	if !ok {
		return row.ReportedCostUSD, 0
	}

	const perMillion = 1_000_000.0
	outputBillable := row.OutputTokens + row.ReasoningTokens
	cacheWrite1hRate := price.CacheWrite1hPerM
	if cacheWrite1hRate <= 0 {
		cacheWrite1hRate = price.CacheWritePerM
	}

	costUSD = (float64(row.InputTokens)*price.InputPerM +
		float64(outputBillable)*price.OutputPerM +
		float64(row.CacheReadTokens)*price.CacheReadPerM +
		float64(row.CacheWriteTokens)*price.CacheWritePerM +
		float64(row.CacheWrite1hTokens)*cacheWrite1hRate) / perMillion

	if row.CacheReadTokens > 0 && price.InputPerM > price.CacheReadPerM {
		cacheSavingsUSD = float64(row.CacheReadTokens) * (price.InputPerM - price.CacheReadPerM) / perMillion
	}
	return costUSD, cacheSavingsUSD
}
