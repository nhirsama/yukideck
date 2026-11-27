package ai_usage

import (
	"regexp"
	"sort"
	"strings"
	"time"
)

// TaggedModel is the output of the model normalization & tagging module.
// DisplayModel drives UI grouping and filtering, while BillingModel + Tags drive pricing.
type TaggedModel struct {
	DisplayModel string
	BillingModel string
	Tags         []string
}

// TimeTagger returns time-dependent billing tags (e.g. "peak" / "offpeak") for a slice hour.
type TimeTagger func(billingModel string, hourBucket time.Time) []string

const (
	TagFast      = "fast"
	TagUltrafast = "ultrafast"
	TagPeak      = "peak"
	TagOffpeak   = "offpeak"
)

var (
	reTagSuffix  = regexp.MustCompile(`:(?:free|beta|extended|thinking|exacto|floor|nitro)$`)
	reDateSuffix = regexp.MustCompile(`(?:[-@](?:20\d{6}|20\d{2}-\d{2}-\d{2})|-v\d+:\d+)$`)

	dotChannelPrefixes = []string{
		"us.anthropic.",
		"eu.anthropic.",
		"apac.anthropic.",
		"global.anthropic.",
		"anthropic.",
	}

	shanghaiLocation = func() *time.Location {
		if loc, err := time.LoadLocation("Asia/Shanghai"); err == nil {
			return loc
		}
		return time.FixedZone("Asia/Shanghai", 8*3600)
	}()
)

// cnStatutoryHolidays holds official China statutory holiday dates ("YYYY-MM-DD", Asia/Shanghai).
// Weekends are already treated as off-peak by IsCNWorkdayPeakHour; full official holiday ranges
// are listed here for clarity and easy annual updates.
var cnStatutoryHolidays = map[string]struct{}{
	// 2025
	"2025-01-01": {}, // 元旦
	"2025-01-28": {}, "2025-01-29": {}, "2025-01-30": {}, "2025-01-31": {},
	"2025-02-01": {}, "2025-02-02": {}, "2025-02-03": {}, "2025-02-04": {}, // 春节
	"2025-04-04": {}, "2025-04-05": {}, "2025-04-06": {}, // 清明
	"2025-05-01": {}, "2025-05-02": {}, "2025-05-03": {}, "2025-05-04": {}, "2025-05-05": {}, // 劳动节
	"2025-05-31": {}, "2025-06-01": {}, "2025-06-02": {}, // 端午
	"2025-10-01": {}, "2025-10-02": {}, "2025-10-03": {}, "2025-10-04": {},
	"2025-10-05": {}, "2025-10-06": {}, "2025-10-07": {}, "2025-10-08": {}, // 国庆、中秋

	// 2026
	"2026-01-01": {}, "2026-01-02": {}, "2026-01-03": {}, // 元旦
	"2026-02-15": {}, "2026-02-16": {}, "2026-02-17": {}, "2026-02-18": {},
	"2026-02-19": {}, "2026-02-20": {}, "2026-02-21": {}, "2026-02-22": {}, "2026-02-23": {}, // 春节
	"2026-04-04": {}, "2026-04-05": {}, "2026-04-06": {}, // 清明
	"2026-05-01": {}, "2026-05-02": {}, "2026-05-03": {}, "2026-05-04": {}, "2026-05-05": {}, // 劳动节
	"2026-06-19": {}, "2026-06-20": {}, "2026-06-21": {}, // 端午
	"2026-09-25": {}, "2026-09-26": {}, "2026-09-27": {}, // 中秋
	"2026-10-01": {}, "2026-10-02": {}, "2026-10-03": {}, "2026-10-04": {},
	"2026-10-05": {}, "2026-10-06": {}, "2026-10-07": {}, // 国庆
}

// builtinTimeTaggers maps canonical BillingModel keys to their time-based tagger function.
var builtinTimeTaggers = map[string]TimeTagger{
	"deepseek-v4-pro":     TagCNPeakOffpeak,
	"deepseek-v4":         TagCNPeakOffpeak,
	"deepseek-v4-flash":   TagCNPeakOffpeak,
	"deepseek-v4.1-flash": TagCNPeakOffpeak,
	"deepseek-flash":      TagCNPeakOffpeak,
}

// IsCNWorkdayPeakHour reports whether t falls into China workday peak hours:
// Asia/Shanghai Monday-Friday (excluding statutory holidays) 09:00-12:00 and 14:00-18:00.
// All other hours (including weekends and statutory holidays all day) are off-peak.
func IsCNWorkdayPeakHour(t time.Time, holidays map[string]struct{}) bool {
	if t.IsZero() {
		return false
	}
	local := t.In(shanghaiLocation)
	switch local.Weekday() {
	case time.Saturday, time.Sunday:
		return false
	}
	if len(holidays) > 0 {
		if _, isHoliday := holidays[local.Format("2006-01-02")]; isHoliday {
			return false
		}
	}
	hour := local.Hour()
	return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

var (
	peakTagSlice    = []string{TagPeak}
	offpeakTagSlice = []string{TagOffpeak}
)

// TagCNPeakOffpeak returns ["peak"] during China workday peak hours and ["offpeak"] otherwise.
func TagCNPeakOffpeak(_ string, hourBucket time.Time) []string {
	if IsCNWorkdayPeakHour(hourBucket, cnStatutoryHolidays) {
		return peakTagSlice
	}
	return offpeakTagSlice
}

// NewCNPeakOffpeakTagger constructs a TimeTagger backed by a custom holiday date set.
func NewCNPeakOffpeakTagger(holidays map[string]struct{}) TimeTagger {
	return func(_ string, hourBucket time.Time) []string {
		if IsCNWorkdayPeakHour(hourBucket, holidays) {
			return peakTagSlice
		}
		return offpeakTagSlice
	}
}

type builtinAliasRule struct {
	pattern   string
	canonical string
}

var builtinAliasRules = []builtinAliasRule{
	// Anthropic Claude Fable / Mythos / 5.5 / 5
	{pattern: "claude-fable-5-2*", canonical: "claude-fable-5.2"},
	{pattern: "claude-fable-5.2*", canonical: "claude-fable-5.2"},
	{pattern: "claude-fable-5-1*", canonical: "claude-fable-5.1"},
	{pattern: "claude-fable-5.1*", canonical: "claude-fable-5.1"},
	{pattern: "claude-fable-5*", canonical: "claude-fable-5"},
	{pattern: "claude-mythos-5-2*", canonical: "claude-mythos-5.2"},
	{pattern: "claude-mythos-5.2*", canonical: "claude-mythos-5.2"},
	{pattern: "claude-mythos-5-1*", canonical: "claude-mythos-5.1"},
	{pattern: "claude-mythos-5.1*", canonical: "claude-mythos-5.1"},
	{pattern: "claude-mythos-5*", canonical: "claude-mythos-5"},
	{pattern: "claude-opus-5-5*", canonical: "claude-opus-5.5"},
	{pattern: "claude-opus-5.5*", canonical: "claude-opus-5.5"},
	{pattern: "claude-5-5-opus*", canonical: "claude-opus-5.5"},
	{pattern: "claude-5.5-opus*", canonical: "claude-opus-5.5"},
	{pattern: "claude-sonnet-5-5*", canonical: "claude-sonnet-5.5"},
	{pattern: "claude-sonnet-5.5*", canonical: "claude-sonnet-5.5"},
	{pattern: "claude-5-5-sonnet*", canonical: "claude-sonnet-5.5"},
	{pattern: "claude-5.5-sonnet*", canonical: "claude-sonnet-5.5"},
	{pattern: "claude-haiku-5-5*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-haiku-5.5*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-5-5-haiku*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-5.5-haiku*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-opus-5*", canonical: "claude-opus-5"},
	{pattern: "claude-5-opus*", canonical: "claude-opus-5"},
	{pattern: "claude-sonnet-5*", canonical: "claude-sonnet-5"},
	{pattern: "claude-5-sonnet*", canonical: "claude-sonnet-5"},
	{pattern: "claude-haiku-5*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-5-haiku*", canonical: "claude-haiku-5.5"},

	// Anthropic Claude 4.x
	{pattern: "claude-opus-4-8*", canonical: "claude-opus-4.8"},
	{pattern: "claude-opus-4.8*", canonical: "claude-opus-4.8"},
	{pattern: "claude-4-8-opus*", canonical: "claude-opus-4.8"},
	{pattern: "claude-4.8-opus*", canonical: "claude-opus-4.8"},
	{pattern: "claude-opus-4-7*", canonical: "claude-opus-4.7"},
	{pattern: "claude-opus-4.7*", canonical: "claude-opus-4.7"},
	{pattern: "claude-4-7-opus*", canonical: "claude-opus-4.7"},
	{pattern: "claude-4.7-opus*", canonical: "claude-opus-4.7"},
	{pattern: "claude-sonnet-4-7*", canonical: "claude-sonnet-4.7"},
	{pattern: "claude-sonnet-4.7*", canonical: "claude-sonnet-4.7"},
	{pattern: "claude-4-7-sonnet*", canonical: "claude-sonnet-4.7"},
	{pattern: "claude-4.7-sonnet*", canonical: "claude-sonnet-4.7"},
	{pattern: "claude-opus-4-6*", canonical: "claude-opus-4.6"},
	{pattern: "claude-opus-4.6*", canonical: "claude-opus-4.6"},
	{pattern: "claude-4-6-opus*", canonical: "claude-opus-4.6"},
	{pattern: "claude-4.6-opus*", canonical: "claude-opus-4.6"},
	{pattern: "claude-sonnet-4-6*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-sonnet-4.6*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-4-6-sonnet*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-4.6-sonnet*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-opus-4-5*", canonical: "claude-opus-4.5"},
	{pattern: "claude-opus-4.5*", canonical: "claude-opus-4.5"},
	{pattern: "claude-4-5-opus*", canonical: "claude-opus-4.5"},
	{pattern: "claude-4.5-opus*", canonical: "claude-opus-4.5"},
	{pattern: "claude-sonnet-4-5*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-sonnet-4.5*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-4-5-sonnet*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-4.5-sonnet*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-haiku-4-5*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-haiku-4.5*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-4-5-haiku*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-4.5-haiku*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-opus-4-1*", canonical: "claude-opus-4.1"},
	{pattern: "claude-opus-4.1*", canonical: "claude-opus-4.1"},
	{pattern: "claude-opus-4*", canonical: "claude-opus-4"},
	{pattern: "claude-sonnet-4*", canonical: "claude-sonnet-4"},

	// Anthropic Claude 3.x
	{pattern: "claude-3-7-sonnet*", canonical: "claude-3.7-sonnet"},
	{pattern: "claude-3.7-sonnet*", canonical: "claude-3.7-sonnet"},
	{pattern: "claude-3-5-sonnet*", canonical: "claude-3.5-sonnet"},
	{pattern: "claude-3.5-sonnet*", canonical: "claude-3.5-sonnet"},
	{pattern: "claude-3-5-haiku*", canonical: "claude-3.5-haiku"},
	{pattern: "claude-3.5-haiku*", canonical: "claude-3.5-haiku"},

	// Google Gemini 4 aliases
	{pattern: "gemini-4.0-neon*", canonical: "gemini-4-neon"},
	{pattern: "gemini-4.0-carbon*", canonical: "gemini-4-carbon"},
	{pattern: "gemini-4.0-argon*", canonical: "gemini-4-argon"},
	{pattern: "gemini-4.0-hydrogen*", canonical: "gemini-4-hydrogen"},
}

// stripChannelPrefixes removes multi-level slash channel prefixes (e.g. a/b/c/model -> model)
// as well as Bedrock-style dot channel prefixes (e.g. us.anthropic.claude-* -> claude-*).
func stripChannelPrefixes(raw string) string {
	cleaned := strings.ToLower(strings.TrimSpace(raw))
	cleaned = strings.TrimRight(cleaned, "/")
	if idx := strings.LastIndex(cleaned, "/"); idx >= 0 && idx < len(cleaned)-1 {
		cleaned = cleaned[idx+1:]
	}
	for {
		stripped := false
		for _, pfx := range dotChannelPrefixes {
			if strings.HasPrefix(cleaned, pfx) {
				cleaned = strings.TrimPrefix(cleaned, pfx)
				stripped = true
				break
			}
		}
		if !stripped {
			break
		}
	}
	return cleaned
}

func stripModelTagsAndDate(s string) string {
	s = reTagSuffix.ReplaceAllString(s, "")
	s = reDateSuffix.ReplaceAllString(s, "")
	return s
}

func patternSpecificity(pattern string) int {
	p := strings.ToLower(strings.TrimSpace(pattern))
	return len(strings.ReplaceAll(p, "*", ""))
}

func appendUniqueLower(dst []string, s string) []string {
	k := strings.ToLower(strings.TrimSpace(s))
	if k == "" {
		return dst
	}
	for _, existing := range dst {
		if existing == k {
			return dst
		}
	}
	return append(dst, k)
}

func appendUniqueTag(dst []string, tag string) []string {
	for _, existing := range dst {
		if existing == tag {
			return dst
		}
	}
	return append(dst, tag)
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

type compiledAliasSet struct {
	exact    []ModelAlias
	wildcard []ModelAlias
}

func compileAliases(userAliases []ModelAlias) compiledAliasSet {
	if len(userAliases) == 0 {
		return compiledAliasSet{}
	}
	exact := make([]ModelAlias, 0, len(userAliases))
	wildcard := make([]ModelAlias, 0, len(userAliases))
	for _, a := range userAliases {
		if strings.TrimSpace(a.MatchPattern) == "" || strings.TrimSpace(a.CanonicalModel) == "" {
			continue
		}
		if strings.Contains(a.MatchPattern, "*") {
			wildcard = append(wildcard, a)
		} else {
			exact = append(exact, a)
		}
	}
	sort.SliceStable(exact, func(i, j int) bool {
		if exact[i].Priority != exact[j].Priority {
			return exact[i].Priority < exact[j].Priority
		}
		return exact[i].ID < exact[j].ID
	})
	sort.SliceStable(wildcard, func(i, j int) bool {
		if wildcard[i].Priority != wildcard[j].Priority {
			return wildcard[i].Priority < wildcard[j].Priority
		}
		si := patternSpecificity(wildcard[i].MatchPattern)
		sj := patternSpecificity(wildcard[j].MatchPattern)
		if si != sj {
			return si > sj
		}
		return wildcard[i].ID < wildcard[j].ID
	})
	return compiledAliasSet{exact: exact, wildcard: wildcard}
}

func (a compiledAliasSet) resolveDisplay(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "unknown"
	}

	stripped := stripChannelPrefixes(trimmed)
	cleaned := stripModelTagsAndDate(stripped)

	candidates := make([]string, 0, 3)
	candidates = appendUniqueLower(candidates, trimmed)
	candidates = appendUniqueLower(candidates, stripped)
	candidates = appendUniqueLower(candidates, cleaned)

	// 1a. User exact aliases always take priority over any wildcard alias.
	for _, c := range candidates {
		for _, rule := range a.exact {
			if strings.EqualFold(strings.TrimSpace(rule.MatchPattern), c) {
				return strings.TrimSpace(rule.CanonicalModel)
			}
		}
	}
	// 1b. User wildcard aliases.
	for _, c := range candidates {
		for _, rule := range a.wildcard {
			if MatchPattern(rule.MatchPattern, c) {
				return strings.TrimSpace(rule.CanonicalModel)
			}
		}
	}

	return applyBuiltinFamilyRules(cleaned)
}

func applyBuiltinFamilyRules(cleaned string) string {
	for _, rule := range builtinAliasRules {
		if !strings.Contains(rule.pattern, "*") && strings.EqualFold(rule.pattern, cleaned) {
			return rule.canonical
		}
	}
	for _, rule := range builtinAliasRules {
		if strings.Contains(rule.pattern, "*") && MatchPattern(rule.pattern, cleaned) {
			return rule.canonical
		}
	}
	return cleaned
}

// extractStaticParameterTags detects static parameter suffixes (such as "-fast" / ":fast",
// "-ultrafast" / ":ultrafast") and returns the stripped base model name plus extracted tags.
// Native models that literally end in "-fast" (e.g. "grok-code-fast") are preserved untouched.
func extractStaticParameterTags(cleaned string, catalog *compiledCatalog) (base string, tags []string) {
	base = cleaned
	if base == "" {
		return "", nil
	}
	if catalog != nil && catalog.isNativeExactBillingModel(base) {
		return base, nil
	}
	staticSuffixes := []struct {
		suffix string
		tag    string
	}{
		{"-ultrafast", TagUltrafast},
		{":ultrafast", TagUltrafast},
		{"-fast", TagFast},
		{":fast", TagFast},
	}
	for _, rule := range staticSuffixes {
		if strings.HasSuffix(base, rule.suffix) {
			candidate := strings.TrimSuffix(base, rule.suffix)
			if candidate != "" {
				base = candidate
				tags = appendUniqueTag(tags, rule.tag)
				break
			}
		}
	}
	return base, tags
}

// resolveBillingFromName maps a single model name (raw or display) into a billing model match
// in the compiled catalog along with any static tags extracted from parameter suffixes.
func resolveBillingFromName(name string, catalog *compiledCatalog) (spec *compiledBillingModel, exact bool, baseKey string, tags []string) {
	stripped := stripChannelPrefixes(name)
	cleaned := stripModelTagsAndDate(stripped)
	if cleaned == "" {
		return nil, false, "", nil
	}

	base, tags := extractStaticParameterTags(cleaned, catalog)
	family := applyBuiltinFamilyRules(base)

	candidates := make([]string, 0, 3)
	candidates = appendUniqueLower(candidates, base)
	candidates = appendUniqueLower(candidates, family)
	candidates = appendUniqueLower(candidates, cleaned)

	// 1. Exact match in versioned billing catalog.
	for _, c := range candidates {
		if s, ok := catalog.exact[c]; ok {
			return s, true, s.billingModel, tags
		}
	}
	// 2. Prefix fallback in versioned billing catalog (longest prefix first).
	for _, s := range catalog.prefixSorted {
		for _, c := range candidates {
			if strings.HasPrefix(c, s.billingModel) {
				return s, false, s.billingModel, tags
			}
		}
	}
	return nil, false, family, tags
}

// NormalizeModel resolves a raw model name to its display model name via user aliases first
// (exact before wildcard), then built-in channel/date stripping and family rules.
func NormalizeModel(raw string, userAliases []ModelAlias) string {
	return compileAliases(userAliases).resolveDisplay(raw)
}
