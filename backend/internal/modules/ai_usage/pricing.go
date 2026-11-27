package ai_usage

import (
	_ "embed"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"
)

//go:embed model_prices_and_context_window.json
var embeddedModelPricesJSON []byte

type litellmPriceEntry struct {
	InputCostPerToken           float64 `json:"input_cost_per_token"`
	OutputCostPerToken          float64 `json:"output_cost_per_token"`
	CacheReadInputTokenCost     float64 `json:"cache_read_input_token_cost"`
	CacheCreationInputTokenCost float64 `json:"cache_creation_input_token_cost"`
	CacheCreation1hTokenCost    float64 `json:"cache_creation_input_token_cost_above_1hr"`
}

type compiledPriceVersion struct {
	effectiveFromUnix int64
	base              RateCard
	tagMultipliers    map[string]float64
}

type compiledBillingModel struct {
	billingModel string
	matchPrefix  bool
	versions     []compiledPriceVersion
}

func (m *compiledBillingModel) lookupVersion(at time.Time) (compiledPriceVersion, bool) {
	n := len(m.versions)
	if n == 0 {
		return compiledPriceVersion{}, false
	}
	if n == 1 && m.versions[0].effectiveFromUnix == math.MinInt64 {
		return m.versions[0], true
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}
	ts := at.UTC().Unix()
	idx := sort.Search(n, func(i int) bool {
		return m.versions[i].effectiveFromUnix > ts
	}) - 1
	if idx < 0 {
		return compiledPriceVersion{}, false
	}
	return m.versions[idx], true
}

func (m *compiledBillingModel) latestBase() RateCard {
	if v, ok := m.lookupVersion(time.Now().UTC()); ok {
		return v.base
	}
	if len(m.versions) == 0 {
		return RateCard{}
	}
	return m.versions[len(m.versions)-1].base
}

type compiledCatalog struct {
	ordered       []*compiledBillingModel
	exact         map[string]*compiledBillingModel
	prefixSorted  []*compiledBillingModel
	embeddedExact map[string]RateCard
	timeTaggers   map[string]TimeTagger
}

func (c *compiledCatalog) isNativeExactBillingModel(name string) bool {
	if _, ok := c.exact[name]; ok {
		return true
	}
	if _, ok := c.embeddedExact[name]; ok {
		return true
	}
	return false
}

var defaultCatalog *compiledCatalog

func init() {
	embedded := loadEmbeddedCatalogPrices(embeddedModelPricesJSON)
	defaultCatalog = compileCatalog(builtinBillingCatalog, builtinTimeTaggers, embedded)
}

func parseEffectiveFrom(raw string) int64 {
	s := strings.TrimSpace(raw)
	if s == "" {
		return math.MinInt64
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC().Unix()
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.UTC().Unix()
	}
	return math.MinInt64
}

func compileCatalog(specs []BillingModelPricing, timeTaggers map[string]TimeTagger, embedded map[string]RateCard) *compiledCatalog {
	cat := &compiledCatalog{
		ordered:       make([]*compiledBillingModel, 0, len(specs)),
		exact:         make(map[string]*compiledBillingModel, len(specs)),
		prefixSorted:  make([]*compiledBillingModel, 0, len(specs)),
		embeddedExact: embedded,
		timeTaggers:   make(map[string]TimeTagger, len(timeTaggers)),
	}
	for k, fn := range timeTaggers {
		key := strings.ToLower(strings.TrimSpace(k))
		if key != "" && fn != nil {
			cat.timeTaggers[key] = fn
		}
	}
	for _, spec := range specs {
		key := strings.ToLower(strings.TrimSpace(spec.BillingModel))
		if key == "" || len(spec.Versions) == 0 {
			continue
		}
		versions := make([]compiledPriceVersion, 0, len(spec.Versions))
		for _, v := range spec.Versions {
			var mults map[string]float64
			if len(v.TagMultipliers) > 0 {
				mults = make(map[string]float64, len(v.TagMultipliers))
				for tk, mv := range v.TagMultipliers {
					ntk := strings.ToLower(strings.TrimSpace(tk))
					if ntk != "" {
						mults[ntk] = mv
					}
				}
			}
			versions = append(versions, compiledPriceVersion{
				effectiveFromUnix: parseEffectiveFrom(v.EffectiveFrom),
				base:              v.Base,
				tagMultipliers:    mults,
			})
		}
		sort.SliceStable(versions, func(i, j int) bool {
			return versions[i].effectiveFromUnix < versions[j].effectiveFromUnix
		})
		cm := &compiledBillingModel{
			billingModel: key,
			matchPrefix:  spec.MatchPrefix,
			versions:     versions,
		}
		cat.ordered = append(cat.ordered, cm)
		cat.exact[key] = cm
		if cm.matchPrefix {
			cat.prefixSorted = append(cat.prefixSorted, cm)
		}
	}
	sort.SliceStable(cat.prefixSorted, func(i, j int) bool {
		return len(cat.prefixSorted[i].billingModel) > len(cat.prefixSorted[j].billingModel)
	})
	return cat
}

func round6(v float64) float64 {
	return math.Round(v*1e6) / 1e6
}

func loadEmbeddedCatalogPrices(raw []byte) map[string]RateCard {
	out := map[string]RateCard{}
	if len(raw) == 0 {
		return out
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return out
	}
	for name, blob := range parsed {
		var entry litellmPriceEntry
		if err := json.Unmarshal(blob, &entry); err != nil {
			continue
		}
		if entry.InputCostPerToken <= 0 && entry.OutputCostPerToken <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(name))
		if key == "" {
			continue
		}
		out[key] = RateCard{
			InputPerM:        round6(entry.InputCostPerToken * 1e6),
			OutputPerM:       round6(entry.OutputCostPerToken * 1e6),
			CacheReadPerM:    round6(entry.CacheReadInputTokenCost * 1e6),
			CacheWritePerM:   round6(entry.CacheCreationInputTokenCost * 1e6),
			CacheWrite1hPerM: round6(entry.CacheCreation1hTokenCost * 1e6),
		}
	}
	return out
}

func rateCardFromModelPrice(p ModelPrice) RateCard {
	return RateCard{
		InputPerM:        p.InputPerM,
		OutputPerM:       p.OutputPerM,
		CacheReadPerM:    p.CacheReadPerM,
		CacheWritePerM:   p.CacheWritePerM,
		CacheWrite1hPerM: p.CacheWrite1hPerM,
	}
}

func modelPriceFromRateCard(pattern string, rc RateCard, builtin bool) ModelPrice {
	return ModelPrice{
		ModelPattern:     pattern,
		InputPerM:        rc.InputPerM,
		OutputPerM:       rc.OutputPerM,
		CacheReadPerM:    rc.CacheReadPerM,
		CacheWritePerM:   rc.CacheWritePerM,
		CacheWrite1hPerM: rc.CacheWrite1hPerM,
		Builtin:          builtin,
	}
}

func scaleRateCard(base RateCard, mul float64) RateCard {
	if mul == 1.0 {
		return base
	}
	return RateCard{
		InputPerM:        base.InputPerM * mul,
		OutputPerM:       base.OutputPerM * mul,
		CacheReadPerM:    base.CacheReadPerM * mul,
		CacheWritePerM:   base.CacheWritePerM * mul,
		CacheWrite1hPerM: base.CacheWrite1hPerM * mul,
	}
}

func computeCostFromRateCard(row HourlySessionRecord, rc RateCard) (costUSD float64, cacheSavingsUSD float64) {
	const perMillion = 1_000_000.0
	outputBillable := row.OutputTokens + row.ReasoningTokens
	cacheWrite1hRate := rc.CacheWrite1hPerM
	if cacheWrite1hRate <= 0 {
		cacheWrite1hRate = rc.CacheWritePerM
	}

	costUSD = (float64(row.InputTokens)*rc.InputPerM +
		float64(outputBillable)*rc.OutputPerM +
		float64(row.CacheReadTokens)*rc.CacheReadPerM +
		float64(row.CacheWriteTokens)*rc.CacheWritePerM +
		float64(row.CacheWrite1hTokens)*cacheWrite1hRate) / perMillion

	if row.CacheReadTokens > 0 && rc.InputPerM > rc.CacheReadPerM {
		cacheSavingsUSD = float64(row.CacheReadTokens) * (rc.InputPerM - rc.CacheReadPerM) / perMillion
	}
	return costUSD, cacheSavingsUSD
}

// DefaultModelPrices returns the latest active built-in base price for each catalog model.
func DefaultModelPrices() []ModelPrice {
	out := make([]ModelPrice, 0, len(defaultCatalog.ordered))
	for _, cm := range defaultCatalog.ordered {
		pattern := cm.billingModel
		if cm.matchPrefix {
			pattern += "*"
		}
		out = append(out, modelPriceFromRateCard(pattern, cm.latestBase(), true))
	}
	return out
}

type compiledUserPrice struct {
	pattern string
	rate    RateCard
}

type cachedModelRoute struct {
	displayModel string
	billingModel string
	staticTags   []string
	timeTagger   TimeTagger

	matched        bool
	matchedPattern string
	matchedBuiltin bool
	staticRate     *RateCard
	builtinSpec    *compiledBillingModel
}

// PriceBook is a per-request compiled pricing resolver that caches model normalization and
// rule routing across slices in a single query.
type PriceBook struct {
	catalog      *compiledCatalog
	aliases      compiledAliasSet
	userExact    map[string]compiledUserPrice
	userWildcard []compiledUserPrice
	routeCache   map[string]cachedModelRoute
}

// NewPriceBook compiles user aliases and custom prices against the default built-in catalog.
func NewPriceBook(userAliases []ModelAlias, userPrices []ModelPrice) *PriceBook {
	return newPriceBookWithCatalog(defaultCatalog, userAliases, userPrices)
}

func newPriceBookWithCatalog(catalog *compiledCatalog, userAliases []ModelAlias, userPrices []ModelPrice) *PriceBook {
	userExact := make(map[string]compiledUserPrice, len(userPrices))
	userWildcard := make([]compiledUserPrice, 0, len(userPrices))
	for _, p := range userPrices {
		key := strings.ToLower(strings.TrimSpace(p.ModelPattern))
		if key == "" {
			continue
		}
		cp := compiledUserPrice{
			pattern: p.ModelPattern,
			rate:    rateCardFromModelPrice(p),
		}
		if strings.Contains(key, "*") {
			userWildcard = append(userWildcard, cp)
		} else {
			if _, exists := userExact[key]; !exists {
				userExact[key] = cp
			}
		}
	}
	sort.SliceStable(userWildcard, func(i, j int) bool {
		si := patternSpecificity(userWildcard[i].pattern)
		sj := patternSpecificity(userWildcard[j].pattern)
		if si != sj {
			return si > sj
		}
		return len(userWildcard[i].pattern) > len(userWildcard[j].pattern)
	})
	return &PriceBook{
		catalog:      catalog,
		aliases:      compileAliases(userAliases),
		userExact:    userExact,
		userWildcard: userWildcard,
		routeCache:   make(map[string]cachedModelRoute, 16),
	}
}

func (b *PriceBook) routeForRaw(rawModel string) cachedModelRoute {
	if route, ok := b.routeCache[rawModel]; ok {
		return route
	}
	display := b.aliases.resolveDisplay(rawModel)
	route := b.computeRoute(rawModel, display)
	b.routeCache[rawModel] = route
	return route
}

func (b *PriceBook) computeRoute(rawModel, displayModel string) cachedModelRoute {
	rawStripped := stripChannelPrefixes(rawModel)
	rawCleaned := stripModelTagsAndDate(rawStripped)
	rawCandidates := make([]string, 0, 3)
	rawCandidates = appendUniqueLower(rawCandidates, rawModel)
	rawCandidates = appendUniqueLower(rawCandidates, rawStripped)
	rawCandidates = appendUniqueLower(rawCandidates, rawCleaned)

	dispStripped := stripChannelPrefixes(displayModel)
	dispCleaned := stripModelTagsAndDate(dispStripped)
	dispCandidates := make([]string, 0, 3)
	dispCandidates = appendUniqueLower(dispCandidates, displayModel)
	dispCandidates = appendUniqueLower(dispCandidates, dispStripped)
	dispCandidates = appendUniqueLower(dispCandidates, dispCleaned)

	// Resolve billing model & static tags from raw model first; fall back to display model
	// so custom user aliases (e.g. private relay names -> standard models) bill accurately.
	billingSpec, billingExact, billingKey, staticTags := resolveBillingFromName(rawModel, b.catalog)
	if billingSpec == nil {
		dispSpec, dispExact, dispKey, dispTags := resolveBillingFromName(displayModel, b.catalog)
		if dispSpec != nil {
			billingSpec = dispSpec
			billingExact = dispExact
			billingKey = dispKey
		} else if billingKey == "" {
			billingKey = dispKey
		}
		for _, tg := range dispTags {
			staticTags = appendUniqueTag(staticTags, tg)
		}
	}

	orderedCandidates := make([]string, 0, len(rawCandidates)+len(dispCandidates)+1)
	for _, c := range rawCandidates {
		orderedCandidates = appendUniqueLower(orderedCandidates, c)
	}
	for _, c := range dispCandidates {
		orderedCandidates = appendUniqueLower(orderedCandidates, c)
	}
	orderedCandidates = appendUniqueLower(orderedCandidates, billingKey)

	route := cachedModelRoute{
		displayModel: displayModel,
		billingModel: billingKey,
		staticTags:   staticTags,
	}

	// Tier 1: User exact price (raw -> display -> billing). User overrides are flat and do not stack built-in tags.
	for _, c := range orderedCandidates {
		if up, ok := b.userExact[c]; ok {
			rc := up.rate
			route.matched = true
			route.matchedPattern = up.pattern
			route.matchedBuiltin = false
			route.staticRate = &rc
			return route
		}
	}

	// Tier 2: Built-in exact price (versioned billing catalog exact match, then embedded LiteLLM catalog exact match).
	if billingSpec != nil && billingExact {
		route.matched = true
		route.matchedPattern = billingSpec.billingModel
		route.matchedBuiltin = true
		route.builtinSpec = billingSpec
		route.timeTagger = b.catalog.timeTaggers[billingSpec.billingModel]
		return route
	}
	for _, c := range orderedCandidates {
		if rc, ok := b.catalog.embeddedExact[c]; ok {
			cp := rc
			route.matched = true
			route.matchedPattern = c
			route.matchedBuiltin = true
			route.staticRate = &cp
			return route
		}
	}

	// Tier 3: User wildcard price (raw -> display -> billing, most specific first).
	for _, up := range b.userWildcard {
		for _, c := range rawCandidates {
			if MatchPattern(up.pattern, c) {
				rc := up.rate
				route.matched = true
				route.matchedPattern = up.pattern
				route.matchedBuiltin = false
				route.staticRate = &rc
				return route
			}
		}
	}
	for _, up := range b.userWildcard {
		for _, c := range dispCandidates {
			if MatchPattern(up.pattern, c) {
				rc := up.rate
				route.matched = true
				route.matchedPattern = up.pattern
				route.matchedBuiltin = false
				route.staticRate = &rc
				return route
			}
		}
	}
	if billingKey != "" {
		for _, up := range b.userWildcard {
			if MatchPattern(up.pattern, billingKey) {
				rc := up.rate
				route.matched = true
				route.matchedPattern = up.pattern
				route.matchedBuiltin = false
				route.staticRate = &rc
				return route
			}
		}
	}

	// Tier 4: Built-in prefix fallback (longest matching billing model prefix).
	if billingSpec != nil {
		route.matched = true
		route.matchedPattern = billingSpec.billingModel
		route.matchedBuiltin = true
		route.builtinSpec = billingSpec
		route.timeTagger = b.catalog.timeTaggers[billingSpec.billingModel]
		return route
	}

	return route
}

// DisplayModel returns the cached display model name for a raw model string.
func (b *PriceBook) DisplayModel(rawModel string) string {
	return b.routeForRaw(rawModel).displayModel
}

// TagSlice resolves display model, billing model, and all tags (static + time-based) for a slice.
func (b *PriceBook) TagSlice(rawModel string, hourBucket time.Time) TaggedModel {
	route := b.routeForRaw(rawModel)
	tags := make([]string, 0, len(route.staticTags)+1)
	tags = append(tags, route.staticTags...)
	if route.timeTagger != nil && !hourBucket.IsZero() {
		for _, tg := range route.timeTagger(route.billingModel, hourBucket) {
			tags = appendUniqueTag(tags, tg)
		}
	}
	return TaggedModel{
		DisplayModel: route.displayModel,
		BillingModel: route.billingModel,
		Tags:         tags,
	}
}

func (b *PriceBook) resolveRateCard(route cachedModelRoute, at time.Time) (RateCard, bool) {
	if !route.matched {
		return RateCard{}, false
	}
	if route.staticRate != nil {
		return *route.staticRate, true
	}
	if route.builtinSpec == nil {
		return RateCard{}, false
	}
	ver, ok := route.builtinSpec.lookupVersion(at)
	if !ok {
		return RateCard{}, false
	}
	if len(ver.tagMultipliers) == 0 {
		return ver.base, true
	}
	mul := 1.0
	for _, tg := range route.staticTags {
		if m, exists := ver.tagMultipliers[tg]; exists {
			mul *= m
		}
	}
	if route.timeTagger != nil && !at.IsZero() {
		for _, tg := range route.timeTagger(route.billingModel, at) {
			if m, exists := ver.tagMultipliers[tg]; exists {
				mul *= m
			}
		}
	}
	return scaleRateCard(ver.base, mul), true
}

// ComputeSliceCost calculates equivalent USD cost and cache savings for one hourly slice.
func (b *PriceBook) ComputeSliceCost(row HourlySessionRecord) (costUSD float64, cacheSavingsUSD float64) {
	route := b.routeForRaw(row.Model)
	rc, ok := b.resolveRateCard(route, row.HourBucket)
	if !ok {
		return row.ReportedCostUSD, 0
	}
	return computeCostFromRateCard(row, rc)
}

// ResolvePrice resolves the latest active pricing for a (rawModel, canonicalModel) pair.
// Preserved for direct callers and tests; query paths use PriceBook for cached versioned lookups.
func ResolvePrice(rawModel, canonicalModel string, userPrices []ModelPrice) (ModelPrice, bool) {
	return ResolvePriceAt(rawModel, canonicalModel, time.Time{}, userPrices)
}

// ResolvePriceAt resolves pricing for a (rawModel, canonicalModel) pair at a specific UTC time.
func ResolvePriceAt(rawModel, canonicalModel string, at time.Time, userPrices []ModelPrice) (ModelPrice, bool) {
	book := NewPriceBook(nil, userPrices)
	route := book.computeRoute(rawModel, canonicalModel)
	rc, ok := book.resolveRateCard(route, at)
	if !ok {
		return ModelPrice{}, false
	}
	return modelPriceFromRateCard(route.matchedPattern, rc, route.matchedBuiltin), true
}

// ComputeCost calculates equivalent USD cost and cache savings for one slice.
func ComputeCost(row HourlySessionRecord, canonicalModel string, userPrices []ModelPrice) (costUSD float64, cacheSavingsUSD float64) {
	book := NewPriceBook(nil, userPrices)
	route := book.computeRoute(row.Model, canonicalModel)
	rc, ok := book.resolveRateCard(route, row.HourBucket)
	if !ok {
		return row.ReportedCostUSD, 0
	}
	return computeCostFromRateCard(row, rc)
}
