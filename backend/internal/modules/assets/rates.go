package assets

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"yukideck/internal/modules/assets/sqlcgen"
)

const (
	defaultRatesURL = "https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD,EUR"
	ratesTTL        = 24 * time.Hour
	refreshCooldown = 5 * time.Minute
)

// Static fallback rates (1 CNY -> quote currency) used only when neither
// upstream nor persisted DB cache is available.
var fallbackCNYRates = map[string]float64{
	"CNY": 1.0,
	"USD": 1.0 / 7.20,
	"EUR": 1.0 / 7.80,
}

type RatesProvider struct {
	store      Store
	endpoint   string
	httpClient *http.Client
	logger     *slog.Logger

	mu               sync.Mutex
	memCache         *ExchangeRatesView
	lastFetchAttempt time.Time
	nowFn            func() time.Time
}

func NewRatesProvider(store Store, timeout time.Duration, logger *slog.Logger) *RatesProvider {
	if timeout <= 0 || timeout > 8*time.Second {
		timeout = 5 * time.Second
	}
	endpoint := strings.TrimSpace(os.Getenv("ASSETS_RATES_URL"))
	if endpoint == "" {
		endpoint = defaultRatesURL
	}
	return &RatesProvider{
		store:      store,
		endpoint:   endpoint,
		httpClient: &http.Client{Timeout: timeout},
		logger:     logger,
		nowFn:      time.Now,
	}
}

func (p *RatesProvider) now() time.Time {
	if p.nowFn != nil {
		return p.nowFn()
	}
	return time.Now()
}

// GetRates returns CNY-based exchange rates for CNY/USD/EUR using a 3-tier
// strategy: fresh memory/DB cache -> live upstream fetch -> cached/static fallback.
func (p *RatesProvider) GetRates(ctx context.Context, forceRefresh bool) ExchangeRatesView {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.now().UTC()

	// 1. Check in-memory cache first.
	if p.memCache != nil {
		age := now.Sub(p.memCache.FetchedAt)
		if !forceRefresh && p.memCache.Source != "fallback" && age < ratesTTL {
			return cloneRatesView(*p.memCache)
		}
		if forceRefresh && p.memCache.Source != "fallback" && now.Sub(p.lastFetchAttempt) < refreshCooldown {
			return cloneRatesView(*p.memCache)
		}
	}

	// 2. Load persisted rates from DB when memory cache is absent or stale.
	var dbCached *ExchangeRatesView
	if p.store != nil {
		if rows, err := p.store.ListExchangeRates(ctx, "CNY"); err == nil && len(rows) > 0 {
			if parsed, ok := buildRatesFromRows(rows); ok {
				dbCached = &parsed
				if !forceRefresh && now.Sub(parsed.FetchedAt) < ratesTTL {
					p.memCache = &parsed
					return cloneRatesView(parsed)
				}
			}
		}
	}

	// 3. Avoid hammering upstream if a recent attempt failed within cooldown.
	if !forceRefresh && !p.lastFetchAttempt.IsZero() && now.Sub(p.lastFetchAttempt) < refreshCooldown {
		if dbCached != nil {
			p.memCache = dbCached
			return cloneRatesView(*dbCached)
		}
		if p.memCache != nil {
			return cloneRatesView(*p.memCache)
		}
		return staticFallbackRates(now)
	}

	// 4. Fetch live rates from upstream.
	p.lastFetchAttempt = now
	if live, err := p.fetchLive(ctx, now); err == nil {
		if p.store != nil {
			for quote, rate := range live.Rates {
				if quote == "CNY" {
					continue
				}
				_ = p.store.UpsertExchangeRate(ctx, sqlcgen.UpsertExchangeRateParams{
					BaseCurrency:  "CNY",
					QuoteCurrency: quote,
					Rate:          rate,
					Source:        "live",
					FetchedAt:     live.FetchedAt,
				})
			}
		}
		p.memCache = &live
		return cloneRatesView(live)
	} else if p.logger != nil {
		p.logger.Warn("assets exchange rate fetch failed, using fallback", "err", err)
	}

	// 5. Fallback to DB cache, then memory cache, then static reference rates.
	if dbCached != nil {
		cached := *dbCached
		cached.Source = "cached"
		p.memCache = &cached
		return cloneRatesView(cached)
	}
	if p.memCache != nil {
		cached := *p.memCache
		if cached.Source == "live" {
			cached.Source = "cached"
		}
		return cloneRatesView(cached)
	}
	fb := staticFallbackRates(now)
	p.memCache = &fb
	return cloneRatesView(fb)
}

type frankfurterPayload struct {
	Base  string             `json:"base"`
	Rates map[string]float64 `json:"rates"`
}

func (p *RatesProvider) fetchLive(ctx context.Context, now time.Time) (ExchangeRatesView, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.endpoint, nil)
	if err != nil {
		return ExchangeRatesView{}, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return ExchangeRatesView{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ExchangeRatesView{}, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	var payload frankfurterPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return ExchangeRatesView{}, err
	}

	usd := payload.Rates["USD"]
	eur := payload.Rates["EUR"]
	if usd <= 0 || eur <= 0 || math.IsNaN(usd) || math.IsNaN(eur) || math.IsInf(usd, 0) || math.IsInf(eur, 0) {
		return ExchangeRatesView{}, fmt.Errorf("invalid rates payload: usd=%v eur=%v", usd, eur)
	}

	return ExchangeRatesView{
		Base: "CNY",
		Rates: map[string]float64{
			"CNY": 1.0,
			"USD": usd,
			"EUR": eur,
		},
		Source:    "live",
		FetchedAt: now,
	}, nil
}

func buildRatesFromRows(rows []sqlcgen.AssetsExchangeRate) (ExchangeRatesView, bool) {
	rates := map[string]float64{"CNY": 1.0}
	var latest time.Time
	for _, r := range rows {
		if r.Rate <= 0 {
			continue
		}
		rates[r.QuoteCurrency] = r.Rate
		if r.FetchedAt.After(latest) {
			latest = r.FetchedAt
		}
	}
	if rates["USD"] <= 0 || rates["EUR"] <= 0 {
		return ExchangeRatesView{}, false
	}
	return ExchangeRatesView{
		Base:      "CNY",
		Rates:     rates,
		Source:    "cached",
		FetchedAt: latest.UTC(),
	}, true
}

func staticFallbackRates(now time.Time) ExchangeRatesView {
	return ExchangeRatesView{
		Base: "CNY",
		Rates: map[string]float64{
			"CNY": fallbackCNYRates["CNY"],
			"USD": fallbackCNYRates["USD"],
			"EUR": fallbackCNYRates["EUR"],
		},
		Source:    "fallback",
		FetchedAt: now,
	}
}

func cloneRatesView(v ExchangeRatesView) ExchangeRatesView {
	out := ExchangeRatesView{
		Base:      v.Base,
		Rates:     make(map[string]float64, len(v.Rates)),
		Source:    v.Source,
		FetchedAt: v.FetchedAt,
	}
	for k, val := range v.Rates {
		out.Rates[k] = val
	}
	return out
}

// ConvertAmount converts an amount in `from` currency into `to` currency using CNY-based rates.
func ConvertAmount(amount float64, from, to string, rates ExchangeRatesView) float64 {
	if amount == 0 || from == to {
		return amount
	}
	fromRate := rateOrFallback(from, rates)
	toRate := rateOrFallback(to, rates)
	inCNY := amount / fromRate
	return inCNY * toRate
}

func rateOrFallback(currency string, rates ExchangeRatesView) float64 {
	if r, ok := rates.Rates[currency]; ok && r > 0 {
		return r
	}
	if r, ok := fallbackCNYRates[currency]; ok && r > 0 {
		return r
	}
	return 1.0
}
