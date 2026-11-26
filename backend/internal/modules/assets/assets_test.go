package assets

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"yukideck/internal/core/httpx"
	"yukideck/internal/modules/assets/sqlcgen"
)

// memStore is an in-memory Store implementation for fast, deterministic unit tests.
type memStore struct {
	mu         sync.Mutex
	nextID     int64
	settings   map[int64]sqlcgen.AssetsUserSetting
	categories map[int64]sqlcgen.AssetsCategory
	tags       map[int64]sqlcgen.AssetsTag
	channels   map[int64]sqlcgen.AssetsChannel
	locations  map[int64]sqlcgen.AssetsLocation
	items      map[int64]sqlcgen.AssetsItem
	itemTags   map[int64]map[int64]bool
	txs        map[int64]sqlcgen.AssetsTransaction
	rates      map[string]sqlcgen.AssetsExchangeRate
}

func newMemStore() *memStore {
	return &memStore{
		nextID:     1,
		settings:   make(map[int64]sqlcgen.AssetsUserSetting),
		categories: make(map[int64]sqlcgen.AssetsCategory),
		tags:       make(map[int64]sqlcgen.AssetsTag),
		channels:   make(map[int64]sqlcgen.AssetsChannel),
		locations:  make(map[int64]sqlcgen.AssetsLocation),
		items:      make(map[int64]sqlcgen.AssetsItem),
		itemTags:   make(map[int64]map[int64]bool),
		txs:        make(map[int64]sqlcgen.AssetsTransaction),
		rates:      make(map[string]sqlcgen.AssetsExchangeRate),
	}
}

func (m *memStore) allocID() int64 {
	id := m.nextID
	m.nextID++
	return id
}

func (m *memStore) EnsureUserSettings(_ context.Context, userID int64) (sqlcgen.AssetsUserSetting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.settings[userID]; ok {
		return s, nil
	}
	s := sqlcgen.AssetsUserSetting{
		UserID:          userID,
		DisplayCurrency: "CNY",
		CostPeriod:      "daily",
		DefaultView:     "card",
		UpdatedAt:       time.Now(),
	}
	m.settings[userID] = s
	return s, nil
}

func (m *memStore) SeedDefaultCategories(_ context.Context, userID int64, seeds []SeedCategory) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.settings[userID]
	if s.SeededCategories {
		return nil
	}
	now := time.Now()
	for i, cat := range seeds {
		pid := m.allocID()
		m.categories[pid] = sqlcgen.AssetsCategory{
			ID: pid, UserID: userID, Name: cat.Name, Icon: cat.Icon, SortOrder: int32(i), CreatedAt: now, UpdatedAt: now,
		}
		for j, child := range cat.Children {
			cid := m.allocID()
			parentCopy := pid
			m.categories[cid] = sqlcgen.AssetsCategory{
				ID: cid, UserID: userID, ParentID: &parentCopy, Name: child.Name, Icon: child.Icon, SortOrder: int32(j), CreatedAt: now, UpdatedAt: now,
			}
		}
	}
	s.SeededCategories = true
	m.settings[userID] = s
	return nil
}

func (m *memStore) UpsertUserSettings(_ context.Context, arg sqlcgen.UpsertUserSettingsParams) (sqlcgen.AssetsUserSetting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.settings[arg.UserID]
	s.UserID = arg.UserID
	s.DisplayCurrency = arg.DisplayCurrency
	s.CostPeriod = arg.CostPeriod
	s.ExcludeRetired = arg.ExcludeRetired
	s.HideAmounts = arg.HideAmounts
	s.DefaultView = arg.DefaultView
	s.UpdatedAt = time.Now()
	m.settings[arg.UserID] = s
	return s, nil
}

func (m *memStore) ListCategories(_ context.Context, userID int64) ([]sqlcgen.AssetsCategory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsCategory, 0)
	for _, c := range m.categories {
		if c.UserID == userID {
			out = append(out, c)
		}
	}
	return out, nil
}

func (m *memStore) GetCategory(_ context.Context, userID, id int64) (sqlcgen.AssetsCategory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.categories[id]
	if !ok || c.UserID != userID {
		return sqlcgen.AssetsCategory{}, httpx.NotFound("分类不存在")
	}
	return c, nil
}

func (m *memStore) CountChildCategories(_ context.Context, userID, parentID int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, c := range m.categories {
		if c.UserID == userID && c.ParentID != nil && *c.ParentID == parentID {
			n++
		}
	}
	return n, nil
}

func (m *memStore) CreateCategory(_ context.Context, userID int64, parentID *int64, name, icon string) (sqlcgen.AssetsCategory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	id := m.allocID()
	row := sqlcgen.AssetsCategory{ID: id, UserID: userID, ParentID: parentID, Name: name, Icon: icon, SortOrder: int32(id), CreatedAt: now, UpdatedAt: now}
	m.categories[id] = row
	return row, nil
}

func (m *memStore) UpdateCategory(_ context.Context, userID, id int64, parentID *int64, name, icon string) (sqlcgen.AssetsCategory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.categories[id]
	if !ok || c.UserID != userID {
		return sqlcgen.AssetsCategory{}, httpx.NotFound("分类不存在")
	}
	c.ParentID = parentID
	c.Name = name
	c.Icon = icon
	c.UpdatedAt = time.Now()
	m.categories[id] = c
	return c, nil
}

func (m *memStore) ReorderCategories(_ context.Context, userID int64, ids []int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, id := range ids {
		if c, ok := m.categories[id]; ok && c.UserID == userID {
			c.SortOrder = int32(i)
			m.categories[id] = c
		}
	}
	return nil
}

func (m *memStore) DeleteCategory(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.categories[id]
	if !ok || c.UserID != userID {
		return httpx.NotFound("分类不存在")
	}
	deleted := map[int64]bool{id: true}
	for cid, child := range m.categories {
		if child.UserID == userID && child.ParentID != nil && *child.ParentID == id {
			deleted[cid] = true
			delete(m.categories, cid)
		}
	}
	delete(m.categories, id)
	for iid, it := range m.items {
		if it.UserID == userID && it.CategoryID != nil && deleted[*it.CategoryID] {
			it.CategoryID = nil
			m.items[iid] = it
		}
	}
	return nil
}

func (m *memStore) ListTags(_ context.Context, userID int64) ([]sqlcgen.AssetsTag, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsTag, 0)
	for _, t := range m.tags {
		if t.UserID == userID {
			out = append(out, t)
		}
	}
	return out, nil
}

func (m *memStore) ListTagsByIDs(_ context.Context, userID int64, ids []int64) ([]sqlcgen.AssetsTag, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsTag, 0)
	for _, id := range ids {
		if t, ok := m.tags[id]; ok && t.UserID == userID {
			out = append(out, t)
		}
	}
	return out, nil
}

func (m *memStore) CreateTag(_ context.Context, userID int64, name, color string) (sqlcgen.AssetsTag, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tags {
		if t.UserID == userID && t.Name == name {
			return sqlcgen.AssetsTag{}, httpx.Conflict("同名标签已存在")
		}
	}
	id := m.allocID()
	row := sqlcgen.AssetsTag{ID: id, UserID: userID, Name: name, Color: color, CreatedAt: time.Now()}
	m.tags[id] = row
	return row, nil
}

func (m *memStore) UpdateTag(_ context.Context, userID, id int64, name, color string) (sqlcgen.AssetsTag, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tags[id]
	if !ok || t.UserID != userID {
		return sqlcgen.AssetsTag{}, httpx.NotFound("标签不存在")
	}
	t.Name = name
	t.Color = color
	m.tags[id] = t
	return t, nil
}

func (m *memStore) DeleteTag(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tags[id]
	if !ok || t.UserID != userID {
		return httpx.NotFound("标签不存在")
	}
	delete(m.tags, id)
	for _, ts := range m.itemTags {
		delete(ts, id)
	}
	return nil
}

func (m *memStore) ListChannels(_ context.Context, userID int64) ([]sqlcgen.AssetsChannel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsChannel, 0)
	for _, c := range m.channels {
		if c.UserID == userID {
			out = append(out, c)
		}
	}
	return out, nil
}

func (m *memStore) GetChannel(_ context.Context, userID, id int64) (sqlcgen.AssetsChannel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.channels[id]
	if !ok || c.UserID != userID {
		return sqlcgen.AssetsChannel{}, httpx.NotFound("购买渠道不存在")
	}
	return c, nil
}

func (m *memStore) CreateChannel(_ context.Context, userID int64, name string) (sqlcgen.AssetsChannel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := m.allocID()
	row := sqlcgen.AssetsChannel{ID: id, UserID: userID, Name: name, CreatedAt: time.Now()}
	m.channels[id] = row
	return row, nil
}

func (m *memStore) UpdateChannel(_ context.Context, userID, id int64, name string) (sqlcgen.AssetsChannel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.channels[id]
	if !ok || c.UserID != userID {
		return sqlcgen.AssetsChannel{}, httpx.NotFound("购买渠道不存在")
	}
	c.Name = name
	m.channels[id] = c
	return c, nil
}

func (m *memStore) DeleteChannel(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.channels[id]
	if !ok || c.UserID != userID {
		return httpx.NotFound("购买渠道不存在")
	}
	delete(m.channels, id)
	return nil
}

func (m *memStore) ListLocations(_ context.Context, userID int64) ([]sqlcgen.AssetsLocation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsLocation, 0)
	for _, l := range m.locations {
		if l.UserID == userID {
			out = append(out, l)
		}
	}
	return out, nil
}

func (m *memStore) GetLocation(_ context.Context, userID, id int64) (sqlcgen.AssetsLocation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.locations[id]
	if !ok || l.UserID != userID {
		return sqlcgen.AssetsLocation{}, httpx.NotFound("存放位置不存在")
	}
	return l, nil
}

func (m *memStore) CreateLocation(_ context.Context, userID int64, name string) (sqlcgen.AssetsLocation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := m.allocID()
	row := sqlcgen.AssetsLocation{ID: id, UserID: userID, Name: name, CreatedAt: time.Now()}
	m.locations[id] = row
	return row, nil
}

func (m *memStore) UpdateLocation(_ context.Context, userID, id int64, name string) (sqlcgen.AssetsLocation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.locations[id]
	if !ok || l.UserID != userID {
		return sqlcgen.AssetsLocation{}, httpx.NotFound("存放位置不存在")
	}
	l.Name = name
	m.locations[id] = l
	return l, nil
}

func (m *memStore) DeleteLocation(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.locations[id]
	if !ok || l.UserID != userID {
		return httpx.NotFound("存放位置不存在")
	}
	delete(m.locations, id)
	return nil
}

func (m *memStore) ListItems(_ context.Context, userID int64) ([]sqlcgen.AssetsItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsItem, 0)
	for _, it := range m.items {
		if it.UserID == userID {
			out = append(out, it)
		}
	}
	return out, nil
}

func (m *memStore) GetItem(_ context.Context, userID, id int64) (sqlcgen.AssetsItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[id]
	if !ok || it.UserID != userID {
		return sqlcgen.AssetsItem{}, httpx.NotFound("物品不存在")
	}
	return it, nil
}

func (m *memStore) CreateItemWithTags(_ context.Context, arg sqlcgen.CreateItemParams, tagIDs []int64) (sqlcgen.AssetsItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	id := m.allocID()
	it := sqlcgen.AssetsItem{
		ID: id, UserID: arg.UserID, ParentID: arg.ParentID, CategoryID: arg.CategoryID,
		ChannelID: arg.ChannelID, LocationID: arg.LocationID, Name: arg.Name, Icon: arg.Icon,
		ImageUrl: arg.ImageUrl, PriceCents: arg.PriceCents, Currency: arg.Currency, PurchasedAt: arg.PurchasedAt,
		PricingMode: arg.PricingMode, Status: arg.Status, ExpectedRetireAt: arg.ExpectedRetireAt,
		WarrantyUntil: arg.WarrantyUntil, UsageCount: arg.UsageCount, SoldCurrency: "CNY",
		Note: arg.Note, SortOrder: int32(id), CreatedAt: now, UpdatedAt: now,
	}
	m.items[id] = it
	m.itemTags[id] = make(map[int64]bool)
	for _, tid := range tagIDs {
		m.itemTags[id][tid] = true
	}
	return it, nil
}

func (m *memStore) UpdateItemWithTags(_ context.Context, arg sqlcgen.UpdateItemParams, tagIDs []int64) (sqlcgen.AssetsItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[arg.ID]
	if !ok || it.UserID != arg.UserID {
		return sqlcgen.AssetsItem{}, httpx.NotFound("物品不存在")
	}
	it.ParentID = arg.ParentID
	it.CategoryID = arg.CategoryID
	it.ChannelID = arg.ChannelID
	it.LocationID = arg.LocationID
	it.Name = arg.Name
	it.Icon = arg.Icon
	it.ImageUrl = arg.ImageUrl
	it.PriceCents = arg.PriceCents
	it.Currency = arg.Currency
	it.PurchasedAt = arg.PurchasedAt
	it.PricingMode = arg.PricingMode
	it.Status = arg.Status
	it.ExpectedRetireAt = arg.ExpectedRetireAt
	it.WarrantyUntil = arg.WarrantyUntil
	it.UsageCount = arg.UsageCount
	it.Note = arg.Note
	it.UpdatedAt = time.Now()
	m.items[arg.ID] = it
	if tagIDs != nil {
		m.itemTags[arg.ID] = make(map[int64]bool)
		for _, tid := range tagIDs {
			m.itemTags[arg.ID][tid] = true
		}
	}
	return it, nil
}

func (m *memStore) DeleteItem(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[id]
	if !ok || it.UserID != userID {
		return httpx.NotFound("物品不存在")
	}
	delete(m.items, id)
	delete(m.itemTags, id)
	for cid, child := range m.items {
		if child.UserID == userID && child.ParentID != nil && *child.ParentID == id {
			child.ParentID = nil
			m.items[cid] = child
		}
	}
	return nil
}

func (m *memStore) AdjustItemUsageCount(_ context.Context, userID, id int64, delta int32) (sqlcgen.AssetsItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[id]
	if !ok || it.UserID != userID {
		return sqlcgen.AssetsItem{}, httpx.NotFound("物品不存在")
	}
	it.UsageCount += delta
	if it.UsageCount < 0 {
		it.UsageCount = 0
	}
	m.items[id] = it
	return it, nil
}

func (m *memStore) RetireItem(_ context.Context, arg sqlcgen.RetireItemParams) (sqlcgen.AssetsItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[arg.ID]
	if !ok || it.UserID != arg.UserID {
		return sqlcgen.AssetsItem{}, httpx.NotFound("物品不存在")
	}
	it.Status = "retired"
	it.RetiredAt = arg.RetiredAt
	it.RetireReason = arg.RetireReason
	it.SoldPriceCents = arg.SoldPriceCents
	it.SoldCurrency = arg.SoldCurrency
	it.RetireNote = arg.RetireNote
	m.items[arg.ID] = it
	return it, nil
}

func (m *memStore) UnretireItem(_ context.Context, userID, id int64) (sqlcgen.AssetsItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[id]
	if !ok || it.UserID != userID {
		return sqlcgen.AssetsItem{}, httpx.NotFound("物品不存在")
	}
	it.Status = "active"
	it.RetiredAt = nil
	it.RetireReason = ""
	it.SoldPriceCents = 0
	it.SoldCurrency = "CNY"
	it.RetireNote = ""
	m.items[id] = it
	return it, nil
}

func (m *memStore) ReorderItems(_ context.Context, userID int64, ids []int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, id := range ids {
		if it, ok := m.items[id]; ok && it.UserID == userID {
			it.SortOrder = int32(i)
			m.items[id] = it
		}
	}
	return nil
}

func (m *memStore) BatchSetItemCategory(_ context.Context, userID int64, categoryID *int64, ids []int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, id := range ids {
		if it, ok := m.items[id]; ok && it.UserID == userID {
			it.CategoryID = categoryID
			m.items[id] = it
			n++
		}
	}
	return n, nil
}

func (m *memStore) BatchRetireItems(_ context.Context, arg sqlcgen.BatchRetireItemsParams) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, id := range arg.Column5 {
		if it, ok := m.items[id]; ok && it.UserID == arg.UserID {
			it.Status = "retired"
			it.RetiredAt = arg.RetiredAt
			it.RetireReason = arg.RetireReason
			it.RetireNote = arg.RetireNote
			m.items[id] = it
			n++
		}
	}
	return n, nil
}

func (m *memStore) BatchDeleteItems(_ context.Context, userID int64, ids []int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, id := range ids {
		if it, ok := m.items[id]; ok && it.UserID == userID {
			delete(m.items, id)
			n++
		}
	}
	return n, nil
}

func (m *memStore) ListItemTagsByUser(_ context.Context, userID int64) ([]sqlcgen.AssetsItemTag, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsItemTag, 0)
	for itemID, tags := range m.itemTags {
		if it, ok := m.items[itemID]; ok && it.UserID == userID {
			for tid := range tags {
				out = append(out, sqlcgen.AssetsItemTag{ItemID: itemID, TagID: tid})
			}
		}
	}
	return out, nil
}

func (m *memStore) ListTransactionsByUser(_ context.Context, userID int64) ([]sqlcgen.AssetsTransaction, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsTransaction, 0)
	for _, tx := range m.txs {
		if tx.UserID == userID {
			out = append(out, tx)
		}
	}
	return out, nil
}

func (m *memStore) ListTransactionsByItem(_ context.Context, userID, itemID int64) ([]sqlcgen.AssetsTransaction, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsTransaction, 0)
	for _, tx := range m.txs {
		if tx.UserID == userID && tx.ItemID == itemID {
			out = append(out, tx)
		}
	}
	return out, nil
}

func (m *memStore) CreateTransaction(_ context.Context, arg sqlcgen.CreateTransactionParams) (sqlcgen.AssetsTransaction, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := m.allocID()
	row := sqlcgen.AssetsTransaction{
		ID: id, UserID: arg.UserID, ItemID: arg.ItemID, Type: arg.Type,
		AmountCents: arg.AmountCents, Currency: arg.Currency, OccurredAt: arg.OccurredAt,
		IncludeInCost: arg.IncludeInCost, Note: arg.Note, CreatedAt: time.Now(),
	}
	m.txs[id] = row
	return row, nil
}

func (m *memStore) UpdateTransaction(_ context.Context, arg sqlcgen.UpdateTransactionParams) (sqlcgen.AssetsTransaction, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	tx, ok := m.txs[arg.ID]
	if !ok || tx.UserID != arg.UserID || tx.ItemID != arg.ItemID {
		return sqlcgen.AssetsTransaction{}, httpx.NotFound("附加收支记录不存在")
	}
	tx.Type = arg.Type
	tx.AmountCents = arg.AmountCents
	tx.Currency = arg.Currency
	tx.OccurredAt = arg.OccurredAt
	tx.IncludeInCost = arg.IncludeInCost
	tx.Note = arg.Note
	m.txs[arg.ID] = tx
	return tx, nil
}

func (m *memStore) DeleteTransaction(_ context.Context, userID, itemID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	tx, ok := m.txs[id]
	if !ok || tx.UserID != userID || tx.ItemID != itemID {
		return httpx.NotFound("附加收支记录不存在")
	}
	delete(m.txs, id)
	return nil
}

func (m *memStore) ListExchangeRates(_ context.Context, baseCurrency string) ([]sqlcgen.AssetsExchangeRate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sqlcgen.AssetsExchangeRate, 0)
	for _, r := range m.rates {
		if r.BaseCurrency == baseCurrency {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *memStore) UpsertExchangeRate(_ context.Context, arg sqlcgen.UpsertExchangeRateParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rates[arg.BaseCurrency+"->"+arg.QuoteCurrency] = sqlcgen.AssetsExchangeRate{
		BaseCurrency:  arg.BaseCurrency,
		QuoteCurrency: arg.QuoteCurrency,
		Rate:          arg.Rate,
		Source:        arg.Source,
		FetchedAt:     arg.FetchedAt,
	}
	return nil
}

func newTestService(t *testing.T, usdPerCNY, eurPerCNY float64) (*Service, *memStore) {
	t.Helper()
	store := newMemStore()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"base": "CNY",
			"rates": map[string]float64{
				"USD": usdPerCNY,
				"EUR": eurPerCNY,
			},
		})
	}))
	t.Cleanup(srv.Close)

	rates := NewRatesProvider(store, 2*time.Second, nil)
	rates.endpoint = srv.URL
	return NewService(store, rates, nil), store
}

func TestSeedCategoriesIdempotentAndTwoLevelLimit(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestService(t, 0.14, 0.13)

	meta, err := svc.GetMeta(ctx, 1)
	if err != nil {
		t.Fatalf("GetMeta: %v", err)
	}
	if len(meta.Categories) == 0 {
		t.Fatalf("expected seeded categories on first visit")
	}

	// Find a level-1 and a level-2 category.
	var l1, l2 CategoryView
	for _, c := range meta.Categories {
		if c.ParentID == nil && l1.ID == 0 {
			l1 = c
		}
		if c.ParentID != nil && l2.ID == 0 {
			l2 = c
		}
	}
	if l1.ID == 0 || l2.ID == 0 {
		t.Fatalf("expected both level-1 and level-2 seeded categories")
	}

	// Creating level-3 under l2 must fail.
	if _, err := svc.CreateCategory(ctx, 1, UpsertCategoryInput{ParentID: &l2.ID, Name: "三级非法"}); err == nil {
		t.Fatalf("expected error creating level-3 category")
	}

	// Demoting l1 (which has children) under another level-1 must fail.
	otherL1, err := svc.CreateCategory(ctx, 1, UpsertCategoryInput{Name: "自定义一级"})
	if err != nil {
		t.Fatalf("CreateCategory: %v", err)
	}
	if _, err := svc.UpdateCategory(ctx, 1, l1.ID, UpsertCategoryInput{ParentID: &otherL1.ID, Name: l1.Name}); err == nil {
		t.Fatalf("expected error demoting category with children")
	}

	// Deleting all categories should NOT cause re-seeding on subsequent GetMeta.
	meta2, _ := svc.GetMeta(ctx, 1)
	for _, c := range meta2.Categories {
		if c.ParentID == nil {
			_ = svc.DeleteCategory(ctx, 1, c.ID)
		}
	}
	meta3, err := svc.GetMeta(ctx, 1)
	if err != nil {
		t.Fatalf("GetMeta after clear: %v", err)
	}
	if len(meta3.Categories) != 0 {
		t.Fatalf("expected 0 categories after user deleted all, got %d", len(meta3.Categories))
	}
}

func TestFinancialCalculationsMultiCurrencyAndPricingModes(t *testing.T) {
	ctx := context.Background()
	// Exact clean rates: 1 CNY = 0.1 USD (1 USD = 10 CNY), 1 CNY = 0.125 EUR (1 EUR = 8 CNY)
	svc, _ := newTestService(t, 0.1, 0.125)
	today := "2026-11-10"

	// 1. Time-based item in USD: $100 (= 1000 CNY), bought 2026-11-01 -> 10 holding days.
	//    Add extra expense 200 CNY (include_in_cost=true) and 50 CNY (include_in_cost=false), plus income 100 CNY.
	//    total_invested = 1200, total_recovered = 100, net_spent = 1100, daily_cost = 1100 / 10 = 110.
	wSoon := "2026-11-20"
	item1, err := svc.CreateItem(ctx, 1, UpsertItemInput{
		Name:          "相机机身",
		Price:         100,
		Currency:      "USD",
		PurchasedAt:   "2026-11-01",
		PricingMode:   "time",
		WarrantyUntil: &wSoon,
	}, today)
	if err != nil {
		t.Fatalf("CreateItem 1: %v", err)
	}
	incTrue := true
	incFalse := false
	if _, err := svc.CreateTransaction(ctx, 1, item1.ID, UpsertTransactionInput{
		Type: "expense", Amount: 200, Currency: "CNY", OccurredAt: "2026-11-02", IncludeInCost: &incTrue,
	}, today); err != nil {
		t.Fatalf("CreateTransaction 1: %v", err)
	}
	if _, err := svc.CreateTransaction(ctx, 1, item1.ID, UpsertTransactionInput{
		Type: "expense", Amount: 50, Currency: "CNY", OccurredAt: "2026-11-03", IncludeInCost: &incFalse,
	}, today); err != nil {
		t.Fatalf("CreateTransaction 2: %v", err)
	}
	if _, err := svc.CreateTransaction(ctx, 1, item1.ID, UpsertTransactionInput{
		Type: "income", Amount: 100, Currency: "CNY", OccurredAt: "2026-11-05",
	}, today); err != nil {
		t.Fatalf("CreateTransaction 3: %v", err)
	}

	// 2. Usage-based item in EUR: 50 EUR (= 400 CNY), used 4 times -> usage_cost = 100, excluded from summary daily cost.
	use4 := int32(4)
	item2, err := svc.CreateItem(ctx, 1, UpsertItemInput{
		Name:        "露营帐篷",
		Price:       50,
		Currency:    "EUR",
		PurchasedAt: "2026-11-01",
		PricingMode: "usage",
		UsageCount:  &use4,
	}, today)
	if err != nil {
		t.Fatalf("CreateItem 2: %v", err)
	}

	// 3. Non-priced item: 300 CNY -> included in total_asset, excluded from daily_cost.
	if _, err := svc.CreateItem(ctx, 1, UpsertItemInput{
		Name:        "纪念徽章",
		Price:       300,
		Currency:    "CNY",
		PurchasedAt: "2026-11-01",
		PricingMode: "none",
	}, today); err != nil {
		t.Fatalf("CreateItem 3: %v", err)
	}

	// 4. Retired time-based item: 500 CNY, bought 2026-10-01, retired 2026-10-10 (frozen at 10 days), sold for 200 CNY -> net = 300, daily = 30.
	item4, err := svc.CreateItem(ctx, 1, UpsertItemInput{
		Name:        "旧耳机",
		Price:       500,
		Currency:    "CNY",
		PurchasedAt: "2026-10-01",
		PricingMode: "time",
	}, today)
	if err != nil {
		t.Fatalf("CreateItem 4: %v", err)
	}
	if _, err := svc.RetireItem(ctx, 1, item4.ID, RetireItemInput{
		RetiredAt:    "2026-10-10",
		RetireReason: "sold",
		SoldPrice:    200,
		SoldCurrency: "CNY",
	}, today); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}

	// List including retired (default)
	res, err := svc.ListItems(ctx, 1, ItemListFilter{Today: today})
	if err != nil {
		t.Fatalf("ListItems: %v", err)
	}

	byID := map[int64]ItemView{}
	for _, it := range res.Items {
		byID[it.ID] = it
	}

	got1 := byID[item1.ID]
	if got1.HoldingDays != 10 || got1.TotalInvested != 1200 || got1.TotalRecovered != 100 || got1.NetSpent != 1100 {
		t.Fatalf("item1 metrics mismatch: %+v", got1)
	}
	if got1.DailyCost == nil || math.Abs(*got1.DailyCost-110) > 0.01 {
		t.Fatalf("item1 daily_cost expected 110, got %v", got1.DailyCost)
	}
	if got1.WarrantyStatus != "expiring_soon" || got1.WarrantyDaysLeft == nil || *got1.WarrantyDaysLeft != 10 {
		t.Fatalf("item1 warranty mismatch: status=%s left=%v", got1.WarrantyStatus, got1.WarrantyDaysLeft)
	}

	got2 := byID[item2.ID]
	if got2.DailyCost != nil || got2.UsageCost == nil || math.Abs(*got2.UsageCost-100) > 0.01 {
		t.Fatalf("item2 usage cost mismatch: daily=%v usage=%v", got2.DailyCost, got2.UsageCost)
	}

	got4 := byID[item4.ID]
	if got4.HoldingDays != 10 || got4.NetSpent != 300 || got4.DailyCost == nil || math.Abs(*got4.DailyCost-30) > 0.01 {
		t.Fatalf("retired item4 metrics mismatch: %+v", got4)
	}

	// Summary including retired: total_asset = 1200 + 400 + 300 + 500 = 2400; recovered = 100 + 200 = 300; daily = 110 + 30 = 140
	if res.Summary.TotalCount != 4 || res.Summary.TotalAsset != 2400 || res.Summary.TotalRecovered != 300 || res.Summary.NetSpent != 2100 {
		t.Fatalf("summary (include retired) mismatch: %+v", res.Summary)
	}
	if res.Summary.TotalDailyCost != 140 || res.Summary.WarrantyExpiringCount != 1 {
		t.Fatalf("summary daily/warranty mismatch: %+v", res.Summary)
	}

	// Summary excluding retired: total_asset = 1200 + 400 + 300 = 1900; daily = 110
	excl := true
	resExcl, err := svc.ListItems(ctx, 1, ItemListFilter{Today: today, ExcludeRetired: &excl})
	if err != nil {
		t.Fatalf("ListItems exclude_retired: %v", err)
	}
	if resExcl.Summary.TotalCount != 3 || resExcl.Summary.TotalAsset != 1900 || resExcl.Summary.TotalDailyCost != 110 {
		t.Fatalf("summary (exclude retired) mismatch: %+v", resExcl.Summary)
	}
}

func TestSubItemsReassignCyclePreventionAndNoDoubleCounting(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestService(t, 0.14, 0.13)
	today := "2026-11-10"

	body, err := svc.CreateItem(ctx, 1, UpsertItemInput{Name: "相机机身", Price: 10000, Currency: "CNY"}, today)
	if err != nil {
		t.Fatalf("create body: %v", err)
	}
	lens, err := svc.CreateItem(ctx, 1, UpsertItemInput{Name: "定焦镜头", Price: 3000, Currency: "CNY", ParentID: &body.ID}, today)
	if err != nil {
		t.Fatalf("create lens: %v", err)
	}
	hood, err := svc.CreateItem(ctx, 1, UpsertItemInput{Name: "遮光罩", Price: 200, Currency: "CNY", ParentID: &lens.ID}, today)
	if err != nil {
		t.Fatalf("create hood: %v", err)
	}

	// Self-loop rejected
	if _, err := svc.UpdateItem(ctx, 1, body.ID, UpsertItemInput{Name: body.Name, Price: body.Price, ParentID: &body.ID}, today); err == nil {
		t.Fatalf("expected error on self parent")
	}
	// Multi-hop cycle (body -> hood -> lens -> body) rejected
	if _, err := svc.UpdateItem(ctx, 1, body.ID, UpsertItemInput{Name: body.Name, Price: body.Price, ParentID: &hood.ID}, today); err == nil {
		t.Fatalf("expected error on cyclic parent chain")
	}

	// Summary total_asset must be 10000 + 3000 + 200 = 13200 (never double-counted),
	// while body reports ChildrenCount=1, ChildrenTotalInvested=3000.
	list, err := svc.ListItems(ctx, 1, ItemListFilter{Today: today})
	if err != nil {
		t.Fatalf("ListItems: %v", err)
	}
	if list.Summary.TotalAsset != 13200 {
		t.Fatalf("expected total_asset 13200, got %v", list.Summary.TotalAsset)
	}
	detail, err := svc.GetItemDetail(ctx, 1, body.ID, today, "")
	if err != nil {
		t.Fatalf("GetItemDetail: %v", err)
	}
	if detail.Item.ChildrenCount != 1 || detail.Item.ChildrenTotalInvested != 3000 || len(detail.Children) != 1 {
		t.Fatalf("unexpected children summary: item=%+v children=%+v", detail.Item, detail.Children)
	}

	// Detach lens (parent_id = nil) works cleanly
	if _, err := svc.UpdateItem(ctx, 1, lens.ID, UpsertItemInput{Name: lens.Name, Price: lens.Price, ParentID: nil}, today); err != nil {
		t.Fatalf("detach lens: %v", err)
	}
	detail2, err := svc.GetItemDetail(ctx, 1, body.ID, today, "")
	if err != nil {
		t.Fatalf("GetItemDetail after detach: %v", err)
	}
	if detail2.Item.ChildrenCount != 0 || len(detail2.Children) != 0 {
		t.Fatalf("expected 0 children after detach, got %d", detail2.Item.ChildrenCount)
	}
}

func TestRatesFallbackWhenUpstreamUnavailable(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	rates := NewRatesProvider(store, 200*time.Millisecond, nil)
	rates.endpoint = "http://127.0.0.1:1/unreachable"

	got := rates.GetRates(ctx, false)
	if got.Source != "fallback" {
		t.Fatalf("expected fallback source, got %s", got.Source)
	}
	if got.Rates["USD"] <= 0 || got.Rates["EUR"] <= 0 {
		t.Fatalf("invalid fallback rates: %+v", got.Rates)
	}
}
