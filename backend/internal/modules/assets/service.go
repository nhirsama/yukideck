package assets

import (
	"context"
	"log/slog"
	"math"
	"sort"
	"strings"
	"time"

	"yukideck/internal/core/httpx"
	"yukideck/internal/modules/assets/sqlcgen"
)

const dateLayout = "2006-01-02"

// ItemListFilter holds all query parameters supported by GET /api/v1/assets/items.
type ItemListFilter struct {
	Today          string
	Currency       string
	ExcludeRetired *bool

	Query          string
	CategoryID     *int64
	Uncategorized  bool
	ExactCategory  bool
	Status         string
	RetireReason   string
	MinPrice       *float64
	MaxPrice       *float64
	MinDailyCost   *float64
	MaxDailyCost   *float64
	PurchasedFrom  string
	PurchasedTo    string
	MinHoldingDays *int
	MaxHoldingDays *int
	MinUsageCount  *int
	MaxUsageCount  *int
	WarrantyStatus string
	TagIDs         []int64
	TagMode        string // "any" (default) | "all"

	SortBy  string
	SortDir string
}

type Service struct {
	store  Store
	rates  *RatesProvider
	logger *slog.Logger
}

func NewService(store Store, rates *RatesProvider, logger *slog.Logger) *Service {
	return &Service{store: store, rates: rates, logger: logger}
}

// --- Bootstrap & Settings ---

func (s *Service) ensureBootstrapped(ctx context.Context, userID int64) (sqlcgen.AssetsUserSetting, error) {
	settings, err := s.store.EnsureUserSettings(ctx, userID)
	if err != nil {
		return sqlcgen.AssetsUserSetting{}, err
	}
	if !settings.SeededCategories {
		if err := s.store.SeedDefaultCategories(ctx, userID, defaultSeedCategories); err != nil {
			return sqlcgen.AssetsUserSetting{}, err
		}
		settings.SeededCategories = true
	}
	return settings, nil
}

func (s *Service) GetMeta(ctx context.Context, userID int64) (MetaResponse, error) {
	settingsRow, err := s.ensureBootstrapped(ctx, userID)
	if err != nil {
		return MetaResponse{}, err
	}
	cats, err := s.store.ListCategories(ctx, userID)
	if err != nil {
		return MetaResponse{}, err
	}
	tags, err := s.store.ListTags(ctx, userID)
	if err != nil {
		return MetaResponse{}, err
	}
	channels, err := s.store.ListChannels(ctx, userID)
	if err != nil {
		return MetaResponse{}, err
	}
	locations, err := s.store.ListLocations(ctx, userID)
	if err != nil {
		return MetaResponse{}, err
	}

	rates := s.rates.GetRates(ctx, false)

	catViews := make([]CategoryView, 0, len(cats))
	for _, c := range cats {
		catViews = append(catViews, toCategoryView(c))
	}
	tagViews := make([]TagView, 0, len(tags))
	for _, t := range tags {
		tagViews = append(tagViews, toTagView(t))
	}
	channelViews := make([]ChannelView, 0, len(channels))
	for _, ch := range channels {
		channelViews = append(channelViews, toChannelView(ch))
	}
	locViews := make([]LocationView, 0, len(locations))
	for _, l := range locations {
		locViews = append(locViews, toLocationView(l))
	}

	return MetaResponse{
		Settings:   toSettingsView(settingsRow),
		Rates:      rates,
		Categories: catViews,
		Tags:       tagViews,
		Channels:   channelViews,
		Locations:  locViews,
	}, nil
}

func (s *Service) UpdateSettings(ctx context.Context, userID int64, in UpdateSettingsInput) (UserSettings, error) {
	cur, err := s.ensureBootstrapped(ctx, userID)
	if err != nil {
		return UserSettings{}, err
	}

	displayCurrency := cur.DisplayCurrency
	if in.DisplayCurrency != nil {
		c, err := validateCurrency(*in.DisplayCurrency)
		if err != nil {
			return UserSettings{}, err
		}
		displayCurrency = c
	}
	costPeriod := cur.CostPeriod
	if in.CostPeriod != nil {
		switch *in.CostPeriod {
		case "daily", "monthly", "yearly":
			costPeriod = *in.CostPeriod
		default:
			return UserSettings{}, httpx.BadRequest("无效的均价口径")
		}
	}
	excludeRetired := cur.ExcludeRetired
	if in.ExcludeRetired != nil {
		excludeRetired = *in.ExcludeRetired
	}
	hideAmounts := cur.HideAmounts
	if in.HideAmounts != nil {
		hideAmounts = *in.HideAmounts
	}
	defaultView := cur.DefaultView
	if in.DefaultView != nil {
		switch *in.DefaultView {
		case "card", "list", "folder":
			defaultView = *in.DefaultView
		default:
			return UserSettings{}, httpx.BadRequest("无效的视图模式")
		}
	}

	updated, err := s.store.UpsertUserSettings(ctx, sqlcgen.UpsertUserSettingsParams{
		UserID:          userID,
		DisplayCurrency: displayCurrency,
		CostPeriod:      costPeriod,
		ExcludeRetired:  excludeRetired,
		HideAmounts:     hideAmounts,
		DefaultView:     defaultView,
	})
	if err != nil {
		return UserSettings{}, err
	}
	return toSettingsView(updated), nil
}

func (s *Service) GetRates(ctx context.Context, forceRefresh bool) ExchangeRatesView {
	return s.rates.GetRates(ctx, forceRefresh)
}

// --- Categories (Strict 2-level hierarchy) ---

func (s *Service) CreateCategory(ctx context.Context, userID int64, in UpsertCategoryInput) (CategoryView, error) {
	if _, err := s.ensureBootstrapped(ctx, userID); err != nil {
		return CategoryView{}, err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return CategoryView{}, httpx.BadRequest("分类名称不能为空")
	}
	icon := strings.TrimSpace(in.Icon)
	if icon == "" {
		icon = "folder"
	}
	if in.ParentID != nil {
		parent, err := s.store.GetCategory(ctx, userID, *in.ParentID)
		if err != nil {
			return CategoryView{}, httpx.BadRequest("父级分类不存在")
		}
		if parent.ParentID != nil {
			return CategoryView{}, httpx.BadRequest("分类最多仅支持两级")
		}
	}
	row, err := s.store.CreateCategory(ctx, userID, in.ParentID, name, icon)
	if err != nil {
		return CategoryView{}, err
	}
	return toCategoryView(row), nil
}

func (s *Service) UpdateCategory(ctx context.Context, userID, id int64, in UpsertCategoryInput) (CategoryView, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return CategoryView{}, httpx.BadRequest("分类名称不能为空")
	}
	icon := strings.TrimSpace(in.Icon)
	if icon == "" {
		icon = "folder"
	}
	if _, err := s.store.GetCategory(ctx, userID, id); err != nil {
		return CategoryView{}, err
	}
	if in.ParentID != nil {
		if *in.ParentID == id {
			return CategoryView{}, httpx.BadRequest("分类不能将自身设为父级")
		}
		parent, err := s.store.GetCategory(ctx, userID, *in.ParentID)
		if err != nil {
			return CategoryView{}, httpx.BadRequest("父级分类不存在")
		}
		if parent.ParentID != nil {
			return CategoryView{}, httpx.BadRequest("分类最多仅支持两级")
		}
		childCount, err := s.store.CountChildCategories(ctx, userID, id)
		if err != nil {
			return CategoryView{}, err
		}
		if childCount > 0 {
			return CategoryView{}, httpx.BadRequest("该分类下已有二级分类，无法降级为二级分类")
		}
	}
	row, err := s.store.UpdateCategory(ctx, userID, id, in.ParentID, name, icon)
	if err != nil {
		return CategoryView{}, err
	}
	return toCategoryView(row), nil
}

func (s *Service) ReorderCategories(ctx context.Context, userID int64, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	return s.store.ReorderCategories(ctx, userID, ids)
}

func (s *Service) DeleteCategory(ctx context.Context, userID, id int64) error {
	return s.store.DeleteCategory(ctx, userID, id)
}

// --- Tags / Channels / Locations ---

func (s *Service) CreateTag(ctx context.Context, userID int64, in UpsertTagInput) (TagView, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return TagView{}, httpx.BadRequest("标签名称不能为空")
	}
	row, err := s.store.CreateTag(ctx, userID, name, strings.TrimSpace(in.Color))
	if err != nil {
		return TagView{}, err
	}
	return toTagView(row), nil
}

func (s *Service) UpdateTag(ctx context.Context, userID, id int64, in UpsertTagInput) (TagView, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return TagView{}, httpx.BadRequest("标签名称不能为空")
	}
	row, err := s.store.UpdateTag(ctx, userID, id, name, strings.TrimSpace(in.Color))
	if err != nil {
		return TagView{}, err
	}
	return toTagView(row), nil
}

func (s *Service) DeleteTag(ctx context.Context, userID, id int64) error {
	return s.store.DeleteTag(ctx, userID, id)
}

func (s *Service) CreateChannel(ctx context.Context, userID int64, in UpsertChannelInput) (ChannelView, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return ChannelView{}, httpx.BadRequest("渠道名称不能为空")
	}
	row, err := s.store.CreateChannel(ctx, userID, name)
	if err != nil {
		return ChannelView{}, err
	}
	return toChannelView(row), nil
}

func (s *Service) UpdateChannel(ctx context.Context, userID, id int64, in UpsertChannelInput) (ChannelView, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return ChannelView{}, httpx.BadRequest("渠道名称不能为空")
	}
	row, err := s.store.UpdateChannel(ctx, userID, id, name)
	if err != nil {
		return ChannelView{}, err
	}
	return toChannelView(row), nil
}

func (s *Service) DeleteChannel(ctx context.Context, userID, id int64) error {
	return s.store.DeleteChannel(ctx, userID, id)
}

func (s *Service) CreateLocation(ctx context.Context, userID int64, in UpsertLocationInput) (LocationView, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return LocationView{}, httpx.BadRequest("存放位置名称不能为空")
	}
	row, err := s.store.CreateLocation(ctx, userID, name)
	if err != nil {
		return LocationView{}, err
	}
	return toLocationView(row), nil
}

func (s *Service) UpdateLocation(ctx context.Context, userID, id int64, in UpsertLocationInput) (LocationView, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return LocationView{}, httpx.BadRequest("存放位置名称不能为空")
	}
	row, err := s.store.UpdateLocation(ctx, userID, id, name)
	if err != nil {
		return LocationView{}, err
	}
	return toLocationView(row), nil
}

func (s *Service) DeleteLocation(ctx context.Context, userID, id int64) error {
	return s.store.DeleteLocation(ctx, userID, id)
}

// --- Items ---

func (s *Service) ListItems(ctx context.Context, userID int64, filter ItemListFilter) (ListItemsResponse, error) {
	settingsRow, err := s.ensureBootstrapped(ctx, userID)
	if err != nil {
		return ListItemsResponse{}, err
	}

	displayCurrency := settingsRow.DisplayCurrency
	if filter.Currency != "" {
		c, err := validateCurrency(filter.Currency)
		if err != nil {
			return ListItemsResponse{}, err
		}
		displayCurrency = c
	}
	excludeRetired := settingsRow.ExcludeRetired
	if filter.ExcludeRetired != nil {
		excludeRetired = *filter.ExcludeRetired
	}
	today, err := parseTodayDate(filter.Today)
	if err != nil {
		return ListItemsResponse{}, err
	}

	rates := s.rates.GetRates(ctx, false)

	env, err := s.loadUserWorkspace(ctx, userID, displayCurrency, today, rates)
	if err != nil {
		return ListItemsResponse{}, err
	}

	// Prepare category filter expansion (parent category includes its child categories unless exact_category=true).
	allowedCategoryIDs := map[int64]bool{}
	if filter.CategoryID != nil {
		allowedCategoryIDs[*filter.CategoryID] = true
		if !filter.ExactCategory {
			for _, c := range env.categories {
				if c.ParentID != nil && *c.ParentID == *filter.CategoryID {
					allowedCategoryIDs[c.ID] = true
				}
			}
		}
	}

	q := strings.ToLower(strings.TrimSpace(filter.Query))
	var purchasedFrom, purchasedTo *time.Time
	if filter.PurchasedFrom != "" {
		t, err := parseDate(filter.PurchasedFrom)
		if err != nil {
			return ListItemsResponse{}, httpx.BadRequest("购买起始日期格式无效")
		}
		purchasedFrom = &t
	}
	if filter.PurchasedTo != "" {
		t, err := parseDate(filter.PurchasedTo)
		if err != nil {
			return ListItemsResponse{}, httpx.BadRequest("购买结束日期格式无效")
		}
		purchasedTo = &t
	}
	tagMode := strings.ToLower(strings.TrimSpace(filter.TagMode))
	if tagMode == "" {
		tagMode = "any"
	}

	filtered := make([]ItemView, 0, len(env.views))
	for _, v := range env.views {
		if !matchesFilter(v, filter, q, allowedCategoryIDs, purchasedFrom, purchasedTo, tagMode) {
			continue
		}
		filtered = append(filtered, v)
	}

	sortItems(filtered, filter.SortBy, filter.SortDir)
	summary := computeSummary(filtered, displayCurrency, excludeRetired)

	return ListItemsResponse{
		Items:   filtered,
		Summary: summary,
		Rates:   rates,
	}, nil
}

func (s *Service) GetItemDetail(ctx context.Context, userID, itemID int64, todayStr, currencyOverride string) (ItemDetailResponse, error) {
	settingsRow, err := s.ensureBootstrapped(ctx, userID)
	if err != nil {
		return ItemDetailResponse{}, err
	}
	displayCurrency := settingsRow.DisplayCurrency
	if currencyOverride != "" {
		c, err := validateCurrency(currencyOverride)
		if err != nil {
			return ItemDetailResponse{}, err
		}
		displayCurrency = c
	}
	today, err := parseTodayDate(todayStr)
	if err != nil {
		return ItemDetailResponse{}, err
	}
	rates := s.rates.GetRates(ctx, false)

	env, err := s.loadUserWorkspace(ctx, userID, displayCurrency, today, rates)
	if err != nil {
		return ItemDetailResponse{}, err
	}

	view, ok := env.viewByID[itemID]
	if !ok {
		return ItemDetailResponse{}, httpx.NotFound("物品不存在")
	}

	var parentRef *ItemRef
	if view.ParentID != nil {
		if pv, ok := env.viewByID[*view.ParentID]; ok {
			ref := toItemRef(pv)
			parentRef = &ref
		}
	}

	children := make([]ItemRef, 0)
	for _, v := range env.views {
		if v.ParentID != nil && *v.ParentID == itemID {
			children = append(children, toItemRef(v))
		}
	}

	txRows := env.txByItem[itemID]
	txViews := make([]TransactionView, 0, len(txRows))
	for _, tx := range txRows {
		txViews = append(txViews, toTransactionView(tx, displayCurrency, rates))
	}

	return ItemDetailResponse{
		Item:         view,
		Parent:       parentRef,
		Children:     children,
		Transactions: txViews,
		Rates:        rates,
	}, nil
}

func (s *Service) CreateItem(ctx context.Context, userID int64, in UpsertItemInput, todayStr string) (ItemView, error) {
	settingsRow, err := s.ensureBootstrapped(ctx, userID)
	if err != nil {
		return ItemView{}, err
	}

	name := strings.TrimSpace(in.Name)
	if name == "" {
		return ItemView{}, httpx.BadRequest("物品名称不能为空")
	}
	if in.Price < 0 {
		return ItemView{}, httpx.BadRequest("购入价格不能为负数")
	}

	currency := settingsRow.DisplayCurrency
	if strings.TrimSpace(in.Currency) != "" {
		currency, err = validateCurrency(in.Currency)
		if err != nil {
			return ItemView{}, err
		}
	}

	pricingMode := "time"
	if strings.TrimSpace(in.PricingMode) != "" {
		pricingMode, err = validatePricingMode(in.PricingMode)
		if err != nil {
			return ItemView{}, err
		}
	}

	status := "active"
	if strings.TrimSpace(in.Status) != "" {
		status, err = validateStatus(in.Status)
		if err != nil {
			return ItemView{}, err
		}
		if status == "retired" {
			return ItemView{}, httpx.BadRequest("请创建后再办理退役，或使用退役接口")
		}
	}

	purchasedAt, err := parseTodayDate(todayStr)
	if err != nil {
		return ItemView{}, err
	}
	if strings.TrimSpace(in.PurchasedAt) != "" {
		purchasedAt, err = parseDate(in.PurchasedAt)
		if err != nil {
			return ItemView{}, httpx.BadRequest("购买日期格式无效，应为 YYYY-MM-DD")
		}
	}

	expectedRetireAt, err := parseOptionalDatePtr(in.ExpectedRetireAt)
	if err != nil {
		return ItemView{}, httpx.BadRequest("预计退役日期格式无效")
	}
	warrantyUntil, err := parseOptionalDatePtr(in.WarrantyUntil)
	if err != nil {
		return ItemView{}, httpx.BadRequest("保修到期日期格式无效")
	}

	usageCount := int32(0)
	if in.UsageCount != nil {
		if *in.UsageCount < 0 {
			return ItemView{}, httpx.BadRequest("使用次数不能为负数")
		}
		usageCount = *in.UsageCount
	}

	if err := s.validateItemRefs(ctx, userID, 0, in.ParentID, in.CategoryID, in.ChannelID, in.LocationID, in.TagIDs); err != nil {
		return ItemView{}, err
	}

	icon := strings.TrimSpace(in.Icon)
	if icon == "" {
		icon = "package"
	}

	created, err := s.store.CreateItemWithTags(ctx, sqlcgen.CreateItemParams{
		UserID:           userID,
		ParentID:         in.ParentID,
		CategoryID:       in.CategoryID,
		ChannelID:        in.ChannelID,
		LocationID:       in.LocationID,
		Name:             name,
		Icon:             icon,
		ImageUrl:         strings.TrimSpace(in.ImageURL),
		PriceCents:       floatToCents(in.Price),
		Currency:         currency,
		PurchasedAt:      purchasedAt,
		PricingMode:      pricingMode,
		Status:           status,
		ExpectedRetireAt: expectedRetireAt,
		WarrantyUntil:    warrantyUntil,
		UsageCount:       usageCount,
		Note:             strings.TrimSpace(in.Note),
	}, dedupeIDs(in.TagIDs))
	if err != nil {
		return ItemView{}, err
	}

	detail, err := s.GetItemDetail(ctx, userID, created.ID, todayStr, "")
	if err != nil {
		return ItemView{}, err
	}
	return detail.Item, nil
}

func (s *Service) UpdateItem(ctx context.Context, userID, itemID int64, in UpsertItemInput, todayStr string) (ItemView, error) {
	cur, err := s.store.GetItem(ctx, userID, itemID)
	if err != nil {
		return ItemView{}, err
	}

	name := strings.TrimSpace(in.Name)
	if name == "" {
		return ItemView{}, httpx.BadRequest("物品名称不能为空")
	}
	if in.Price < 0 {
		return ItemView{}, httpx.BadRequest("购入价格不能为负数")
	}

	currency := cur.Currency
	if strings.TrimSpace(in.Currency) != "" {
		currency, err = validateCurrency(in.Currency)
		if err != nil {
			return ItemView{}, err
		}
	}

	pricingMode := cur.PricingMode
	if strings.TrimSpace(in.PricingMode) != "" {
		pricingMode, err = validatePricingMode(in.PricingMode)
		if err != nil {
			return ItemView{}, err
		}
	}

	status := cur.Status
	if strings.TrimSpace(in.Status) != "" {
		status, err = validateStatus(in.Status)
		if err != nil {
			return ItemView{}, err
		}
	}

	purchasedAt := cur.PurchasedAt
	if strings.TrimSpace(in.PurchasedAt) != "" {
		purchasedAt, err = parseDate(in.PurchasedAt)
		if err != nil {
			return ItemView{}, httpx.BadRequest("购买日期格式无效")
		}
	}

	expectedRetireAt := cur.ExpectedRetireAt
	if in.ExpectedRetireAt != nil {
		expectedRetireAt, err = parseOptionalDatePtr(in.ExpectedRetireAt)
		if err != nil {
			return ItemView{}, httpx.BadRequest("预计退役日期格式无效")
		}
	}
	warrantyUntil := cur.WarrantyUntil
	if in.WarrantyUntil != nil {
		warrantyUntil, err = parseOptionalDatePtr(in.WarrantyUntil)
		if err != nil {
			return ItemView{}, httpx.BadRequest("保修到期日期格式无效")
		}
	}

	usageCount := cur.UsageCount
	if in.UsageCount != nil {
		if *in.UsageCount < 0 {
			return ItemView{}, httpx.BadRequest("使用次数不能为负数")
		}
		usageCount = *in.UsageCount
	}

	if err := s.validateItemRefs(ctx, userID, itemID, in.ParentID, in.CategoryID, in.ChannelID, in.LocationID, in.TagIDs); err != nil {
		return ItemView{}, err
	}

	icon := strings.TrimSpace(in.Icon)
	if icon == "" {
		icon = cur.Icon
	}
	if icon == "" {
		icon = "package"
	}

	var tagIDs []int64
	if in.TagIDs != nil {
		tagIDs = dedupeIDs(in.TagIDs)
	}

	_, err = s.store.UpdateItemWithTags(ctx, sqlcgen.UpdateItemParams{
		UserID:           userID,
		ID:               itemID,
		ParentID:         in.ParentID,
		CategoryID:       in.CategoryID,
		ChannelID:        in.ChannelID,
		LocationID:       in.LocationID,
		Name:             name,
		Icon:             icon,
		ImageUrl:         strings.TrimSpace(in.ImageURL),
		PriceCents:       floatToCents(in.Price),
		Currency:         currency,
		PurchasedAt:      purchasedAt,
		PricingMode:      pricingMode,
		Status:           status,
		ExpectedRetireAt: expectedRetireAt,
		WarrantyUntil:    warrantyUntil,
		UsageCount:       usageCount,
		Note:             strings.TrimSpace(in.Note),
	}, tagIDs)
	if err != nil {
		return ItemView{}, err
	}

	detail, err := s.GetItemDetail(ctx, userID, itemID, todayStr, "")
	if err != nil {
		return ItemView{}, err
	}
	return detail.Item, nil
}

func (s *Service) DeleteItem(ctx context.Context, userID, itemID int64) error {
	return s.store.DeleteItem(ctx, userID, itemID)
}

func (s *Service) UseItem(ctx context.Context, userID, itemID int64, delta int32, todayStr string) (ItemView, error) {
	if delta == 0 {
		delta = 1
	}
	if _, err := s.store.AdjustItemUsageCount(ctx, userID, itemID, delta); err != nil {
		return ItemView{}, err
	}
	detail, err := s.GetItemDetail(ctx, userID, itemID, todayStr, "")
	if err != nil {
		return ItemView{}, err
	}
	return detail.Item, nil
}

func (s *Service) RetireItem(ctx context.Context, userID, itemID int64, in RetireItemInput, todayStr string) (ItemView, error) {
	reason, err := validateRetireReason(in.RetireReason, true)
	if err != nil {
		return ItemView{}, err
	}
	if in.SoldPrice < 0 {
		return ItemView{}, httpx.BadRequest("出售所得不能为负数")
	}
	soldCurrency := "CNY"
	if strings.TrimSpace(in.SoldCurrency) != "" {
		soldCurrency, err = validateCurrency(in.SoldCurrency)
		if err != nil {
			return ItemView{}, err
		}
	}
	retiredAt, err := parseTodayDate(todayStr)
	if err != nil {
		return ItemView{}, err
	}
	if strings.TrimSpace(in.RetiredAt) != "" {
		retiredAt, err = parseDate(in.RetiredAt)
		if err != nil {
			return ItemView{}, httpx.BadRequest("退役日期格式无效")
		}
	}

	if _, err := s.store.RetireItem(ctx, sqlcgen.RetireItemParams{
		UserID:         userID,
		ID:             itemID,
		RetiredAt:      &retiredAt,
		RetireReason:   reason,
		SoldPriceCents: floatToCents(in.SoldPrice),
		SoldCurrency:   soldCurrency,
		RetireNote:     strings.TrimSpace(in.RetireNote),
	}); err != nil {
		return ItemView{}, err
	}

	detail, err := s.GetItemDetail(ctx, userID, itemID, todayStr, "")
	if err != nil {
		return ItemView{}, err
	}
	return detail.Item, nil
}

func (s *Service) UnretireItem(ctx context.Context, userID, itemID int64, todayStr string) (ItemView, error) {
	if _, err := s.store.UnretireItem(ctx, userID, itemID); err != nil {
		return ItemView{}, err
	}
	detail, err := s.GetItemDetail(ctx, userID, itemID, todayStr, "")
	if err != nil {
		return ItemView{}, err
	}
	return detail.Item, nil
}

func (s *Service) ReorderItems(ctx context.Context, userID int64, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	return s.store.ReorderItems(ctx, userID, dedupeIDs(ids))
}

func (s *Service) BatchItems(ctx context.Context, userID int64, in BatchItemInput, todayStr string) (int64, error) {
	ids := dedupeIDs(in.ItemIDs)
	if len(ids) == 0 {
		return 0, httpx.BadRequest("请至少选择一件物品")
	}

	switch in.Action {
	case "set_category":
		if in.CategoryID != nil {
			if _, err := s.store.GetCategory(ctx, userID, *in.CategoryID); err != nil {
				return 0, httpx.BadRequest("目标分类不存在")
			}
		}
		return s.store.BatchSetItemCategory(ctx, userID, in.CategoryID, ids)
	case "retire":
		reason := in.RetireReason
		if reason == "" {
			reason = "other"
		}
		validatedReason, err := validateRetireReason(reason, true)
		if err != nil {
			return 0, err
		}
		retiredAt, err := parseTodayDate(todayStr)
		if err != nil {
			return 0, err
		}
		if strings.TrimSpace(in.RetiredAt) != "" {
			retiredAt, err = parseDate(in.RetiredAt)
			if err != nil {
				return 0, httpx.BadRequest("退役日期格式无效")
			}
		}
		return s.store.BatchRetireItems(ctx, sqlcgen.BatchRetireItemsParams{
			UserID:       userID,
			RetiredAt:    &retiredAt,
			RetireReason: validatedReason,
			RetireNote:   strings.TrimSpace(in.RetireNote),
			Column5:      ids,
		})
	case "delete":
		return s.store.BatchDeleteItems(ctx, userID, ids)
	default:
		return 0, httpx.BadRequest("不支持的批量操作类型")
	}
}

// --- Transactions ---

func (s *Service) CreateTransaction(ctx context.Context, userID, itemID int64, in UpsertTransactionInput, todayStr string) (TransactionView, error) {
	settingsRow, err := s.ensureBootstrapped(ctx, userID)
	if err != nil {
		return TransactionView{}, err
	}
	if _, err := s.store.GetItem(ctx, userID, itemID); err != nil {
		return TransactionView{}, err
	}
	txType, err := validateTxType(in.Type)
	if err != nil {
		return TransactionView{}, err
	}
	if in.Amount < 0 {
		return TransactionView{}, httpx.BadRequest("金额不能为负数")
	}
	currency := settingsRow.DisplayCurrency
	if strings.TrimSpace(in.Currency) != "" {
		currency, err = validateCurrency(in.Currency)
		if err != nil {
			return TransactionView{}, err
		}
	}
	occurredAt, err := parseTodayDate(todayStr)
	if err != nil {
		return TransactionView{}, err
	}
	if strings.TrimSpace(in.OccurredAt) != "" {
		occurredAt, err = parseDate(in.OccurredAt)
		if err != nil {
			return TransactionView{}, httpx.BadRequest("发生日期格式无效")
		}
	}
	includeInCost := true
	if in.IncludeInCost != nil {
		includeInCost = *in.IncludeInCost
	}

	row, err := s.store.CreateTransaction(ctx, sqlcgen.CreateTransactionParams{
		UserID:        userID,
		ItemID:        itemID,
		Type:          txType,
		AmountCents:   floatToCents(in.Amount),
		Currency:      currency,
		OccurredAt:    occurredAt,
		IncludeInCost: includeInCost,
		Note:          strings.TrimSpace(in.Note),
	})
	if err != nil {
		return TransactionView{}, err
	}
	rates := s.rates.GetRates(ctx, false)
	return toTransactionView(row, settingsRow.DisplayCurrency, rates), nil
}

func (s *Service) UpdateTransaction(ctx context.Context, userID, itemID, txID int64, in UpsertTransactionInput, todayStr string) (TransactionView, error) {
	settingsRow, err := s.ensureBootstrapped(ctx, userID)
	if err != nil {
		return TransactionView{}, err
	}
	txType, err := validateTxType(in.Type)
	if err != nil {
		return TransactionView{}, err
	}
	if in.Amount < 0 {
		return TransactionView{}, httpx.BadRequest("金额不能为负数")
	}
	currency := settingsRow.DisplayCurrency
	if strings.TrimSpace(in.Currency) != "" {
		currency, err = validateCurrency(in.Currency)
		if err != nil {
			return TransactionView{}, err
		}
	}
	occurredAt, err := parseTodayDate(todayStr)
	if err != nil {
		return TransactionView{}, err
	}
	if strings.TrimSpace(in.OccurredAt) != "" {
		occurredAt, err = parseDate(in.OccurredAt)
		if err != nil {
			return TransactionView{}, httpx.BadRequest("发生日期格式无效")
		}
	}
	includeInCost := true
	if in.IncludeInCost != nil {
		includeInCost = *in.IncludeInCost
	}

	row, err := s.store.UpdateTransaction(ctx, sqlcgen.UpdateTransactionParams{
		UserID:        userID,
		ItemID:        itemID,
		ID:            txID,
		Type:          txType,
		AmountCents:   floatToCents(in.Amount),
		Currency:      currency,
		OccurredAt:    occurredAt,
		IncludeInCost: includeInCost,
		Note:          strings.TrimSpace(in.Note),
	})
	if err != nil {
		return TransactionView{}, err
	}
	rates := s.rates.GetRates(ctx, false)
	return toTransactionView(row, settingsRow.DisplayCurrency, rates), nil
}

func (s *Service) DeleteTransaction(ctx context.Context, userID, itemID, txID int64) error {
	return s.store.DeleteTransaction(ctx, userID, itemID, txID)
}

// --- Internal workspace loader & calculation engine ---

type workspaceSnapshot struct {
	categories []sqlcgen.AssetsCategory
	views      []ItemView
	viewByID   map[int64]ItemView
	txByItem   map[int64][]sqlcgen.AssetsTransaction
}

func (s *Service) loadUserWorkspace(
	ctx context.Context,
	userID int64,
	displayCurrency string,
	today time.Time,
	rates ExchangeRatesView,
) (*workspaceSnapshot, error) {
	items, err := s.store.ListItems(ctx, userID)
	if err != nil {
		return nil, err
	}
	categories, err := s.store.ListCategories(ctx, userID)
	if err != nil {
		return nil, err
	}
	tags, err := s.store.ListTags(ctx, userID)
	if err != nil {
		return nil, err
	}
	channels, err := s.store.ListChannels(ctx, userID)
	if err != nil {
		return nil, err
	}
	locations, err := s.store.ListLocations(ctx, userID)
	if err != nil {
		return nil, err
	}
	itemTags, err := s.store.ListItemTagsByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	txs, err := s.store.ListTransactionsByUser(ctx, userID)
	if err != nil {
		return nil, err
	}

	catByID := make(map[int64]sqlcgen.AssetsCategory, len(categories))
	for _, c := range categories {
		catByID[c.ID] = c
	}
	tagByID := make(map[int64]TagView, len(tags))
	for _, t := range tags {
		tagByID[t.ID] = toTagView(t)
	}
	chByID := make(map[int64]string, len(channels))
	for _, ch := range channels {
		chByID[ch.ID] = ch.Name
	}
	locByID := make(map[int64]string, len(locations))
	for _, l := range locations {
		locByID[l.ID] = l.Name
	}
	itemNameByID := make(map[int64]string, len(items))
	for _, it := range items {
		itemNameByID[it.ID] = it.Name
	}

	tagsByItem := make(map[int64][]TagView)
	for _, it := range itemTags {
		if tv, ok := tagByID[it.TagID]; ok {
			tagsByItem[it.ItemID] = append(tagsByItem[it.ItemID], tv)
		}
	}

	txByItem := make(map[int64][]sqlcgen.AssetsTransaction)
	for _, tx := range txs {
		txByItem[tx.ItemID] = append(txByItem[tx.ItemID], tx)
	}

	// Build each ItemView's core metrics first.
	views := make([]ItemView, 0, len(items))
	viewIdxByID := make(map[int64]int, len(items))

	for _, it := range items {
		v := buildItemView(it, displayCurrency, today, rates, catByID, chByID, locByID, itemNameByID, tagsByItem[it.ID], txByItem[it.ID])
		viewIdxByID[it.ID] = len(views)
		views = append(views, v)
	}

	// Aggregate direct children counts & investments onto parent items.
	for _, v := range views {
		if v.ParentID != nil {
			if pIdx, ok := viewIdxByID[*v.ParentID]; ok {
				views[pIdx].ChildrenCount++
				views[pIdx].ChildrenTotalInvested = round2(views[pIdx].ChildrenTotalInvested + v.TotalInvested)
			}
		}
	}

	viewByID := make(map[int64]ItemView, len(views))
	for _, v := range views {
		viewByID[v.ID] = v
	}

	return &workspaceSnapshot{
		categories: categories,
		views:      views,
		viewByID:   viewByID,
		txByItem:   txByItem,
	}, nil
}

func buildItemView(
	it sqlcgen.AssetsItem,
	displayCurrency string,
	today time.Time,
	rates ExchangeRatesView,
	catByID map[int64]sqlcgen.AssetsCategory,
	chByID map[int64]string,
	locByID map[int64]string,
	itemNameByID map[int64]string,
	tags []TagView,
	txs []sqlcgen.AssetsTransaction,
) ItemView {
	if tags == nil {
		tags = []TagView{}
	}

	price := centsToFloat(it.PriceCents)
	convertedPrice := ConvertAmount(price, it.Currency, displayCurrency, rates)
	soldPrice := centsToFloat(it.SoldPriceCents)
	convertedSold := ConvertAmount(soldPrice, it.SoldCurrency, displayCurrency, rates)

	var extraExpense, extraIncome float64
	for _, tx := range txs {
		amt := ConvertAmount(centsToFloat(tx.AmountCents), tx.Currency, displayCurrency, rates)
		switch tx.Type {
		case "expense":
			if tx.IncludeInCost {
				extraExpense += amt
			}
		case "income":
			extraIncome += amt
		}
	}

	totalInvested := convertedPrice + extraExpense
	totalRecovered := extraIncome
	if it.Status == "retired" {
		totalRecovered += convertedSold
	}
	netSpent := totalInvested - totalRecovered

	// Holding days (inclusive of purchase day, minimum 1; frozen at retired_at if retired).
	startDate := truncateDate(it.PurchasedAt)
	endDate := today
	if it.Status == "retired" && it.RetiredAt != nil {
		endDate = truncateDate(*it.RetiredAt)
	}
	holdingDays := int(endDate.Sub(startDate).Hours()/24) + 1
	if holdingDays < 1 {
		holdingDays = 1
	}

	var dailyCost *float64
	var usageCost *float64
	effectiveNet := math.Max(0, netSpent)
	switch it.PricingMode {
	case "time":
		dc := round2(effectiveNet / float64(holdingDays))
		dailyCost = &dc
	case "usage":
		denom := float64(it.UsageCount)
		if denom < 1 {
			denom = 1
		}
		uc := round2(effectiveNet / denom)
		usageCost = &uc
	}

	// Warranty countdown
	warrantyStatus := "none"
	var warrantyDaysLeft *int
	var warrantyStr *string
	if it.WarrantyUntil != nil {
		wDate := truncateDate(*it.WarrantyUntil)
		s := wDate.Format(dateLayout)
		warrantyStr = &s
		diff := int(wDate.Sub(today).Hours() / 24)
		warrantyDaysLeft = &diff
		switch {
		case diff < 0:
			warrantyStatus = "expired"
		case diff <= 30:
			warrantyStatus = "expiring_soon"
		default:
			warrantyStatus = "active"
		}
	}

	var parentName, categoryName, channelName, locationName string
	if it.ParentID != nil {
		parentName = itemNameByID[*it.ParentID]
	}
	if it.CategoryID != nil {
		if c, ok := catByID[*it.CategoryID]; ok {
			if c.ParentID != nil {
				if p, ok := catByID[*c.ParentID]; ok {
					categoryName = p.Name + " / " + c.Name
				} else {
					categoryName = c.Name
				}
			} else {
				categoryName = c.Name
			}
		}
	}
	if it.ChannelID != nil {
		channelName = chByID[*it.ChannelID]
	}
	if it.LocationID != nil {
		locationName = locByID[*it.LocationID]
	}

	return ItemView{
		ID:               it.ID,
		ParentID:         it.ParentID,
		ParentName:       parentName,
		CategoryID:       it.CategoryID,
		CategoryName:     categoryName,
		ChannelID:        it.ChannelID,
		ChannelName:      channelName,
		LocationID:       it.LocationID,
		LocationName:     locationName,
		Name:             it.Name,
		Icon:             it.Icon,
		ImageURL:         it.ImageUrl,
		Price:            price,
		Currency:         it.Currency,
		ConvertedPrice:   round2(convertedPrice),
		DisplayCurrency:  displayCurrency,
		PurchasedAt:      startDate.Format(dateLayout),
		PricingMode:      it.PricingMode,
		Status:           it.Status,
		ExpectedRetireAt: formatOptionalDate(it.ExpectedRetireAt),
		WarrantyUntil:    warrantyStr,
		WarrantyDaysLeft: warrantyDaysLeft,
		WarrantyStatus:   warrantyStatus,
		UsageCount:       it.UsageCount,
		RetiredAt:        formatOptionalDate(it.RetiredAt),
		RetireReason:     it.RetireReason,
		SoldPrice:        soldPrice,
		SoldCurrency:     it.SoldCurrency,
		RetireNote:       it.RetireNote,
		Note:             it.Note,
		SortOrder:        it.SortOrder,
		Tags:             tags,
		HoldingDays:      holdingDays,
		ExtraExpense:     round2(extraExpense),
		ExtraIncome:      round2(extraIncome),
		TotalInvested:    round2(totalInvested),
		TotalRecovered:   round2(totalRecovered),
		NetSpent:         round2(netSpent),
		DailyCost:        dailyCost,
		UsageCost:        usageCost,
		CreatedAt:        it.CreatedAt,
		UpdatedAt:        it.UpdatedAt,
	}
}

func matchesFilter(
	v ItemView,
	f ItemListFilter,
	q string,
	allowedCategoryIDs map[int64]bool,
	purchasedFrom, purchasedTo *time.Time,
	tagMode string,
) bool {
	if q != "" {
		matched := strings.Contains(strings.ToLower(v.Name), q) ||
			strings.Contains(strings.ToLower(v.Note), q) ||
			strings.Contains(strings.ToLower(v.ChannelName), q) ||
			strings.Contains(strings.ToLower(v.LocationName), q) ||
			strings.Contains(strings.ToLower(v.CategoryName), q)
		if !matched {
			for _, t := range v.Tags {
				if strings.Contains(strings.ToLower(t.Name), q) {
					matched = true
					break
				}
			}
		}
		if !matched {
			return false
		}
	}

	if f.Uncategorized {
		if v.CategoryID != nil {
			return false
		}
	} else if f.CategoryID != nil {
		if v.CategoryID == nil || !allowedCategoryIDs[*v.CategoryID] {
			return false
		}
	}

	if f.Status != "" && v.Status != f.Status {
		return false
	}
	if f.RetireReason != "" && v.RetireReason != f.RetireReason {
		return false
	}

	if f.MinPrice != nil && v.ConvertedPrice < *f.MinPrice {
		return false
	}
	if f.MaxPrice != nil && v.ConvertedPrice > *f.MaxPrice {
		return false
	}

	if f.MinDailyCost != nil || f.MaxDailyCost != nil {
		if v.DailyCost == nil {
			return false
		}
		if f.MinDailyCost != nil && *v.DailyCost < *f.MinDailyCost {
			return false
		}
		if f.MaxDailyCost != nil && *v.DailyCost > *f.MaxDailyCost {
			return false
		}
	}

	if purchasedFrom != nil || purchasedTo != nil {
		pDate, err := parseDate(v.PurchasedAt)
		if err != nil {
			return false
		}
		if purchasedFrom != nil && pDate.Before(*purchasedFrom) {
			return false
		}
		if purchasedTo != nil && pDate.After(*purchasedTo) {
			return false
		}
	}

	if f.MinHoldingDays != nil && v.HoldingDays < *f.MinHoldingDays {
		return false
	}
	if f.MaxHoldingDays != nil && v.HoldingDays > *f.MaxHoldingDays {
		return false
	}

	if f.MinUsageCount != nil && int(v.UsageCount) < *f.MinUsageCount {
		return false
	}
	if f.MaxUsageCount != nil && int(v.UsageCount) > *f.MaxUsageCount {
		return false
	}

	if f.WarrantyStatus != "" && v.WarrantyStatus != f.WarrantyStatus {
		return false
	}

	if len(f.TagIDs) > 0 {
		itemTagSet := make(map[int64]bool, len(v.Tags))
		for _, t := range v.Tags {
			itemTagSet[t.ID] = true
		}
		if tagMode == "all" {
			for _, reqID := range f.TagIDs {
				if !itemTagSet[reqID] {
					return false
				}
			}
		} else {
			anyMatch := false
			for _, reqID := range f.TagIDs {
				if itemTagSet[reqID] {
					anyMatch = true
					break
				}
			}
			if !anyMatch {
				return false
			}
		}
	}

	return true
}

func computeSummary(items []ItemView, displayCurrency string, excludeRetired bool) SummaryView {
	s := SummaryView{DisplayCurrency: displayCurrency}
	var totalInvested, totalRecovered, totalDaily float64

	for _, it := range items {
		if it.Status != "retired" {
			if it.WarrantyStatus == "expiring_soon" {
				s.WarrantyExpiringCount++
			} else if it.WarrantyStatus == "expired" {
				s.WarrantyExpiredCount++
			}
		}
		if excludeRetired && it.Status == "retired" {
			continue
		}
		s.TotalCount++
		totalInvested += it.TotalInvested
		totalRecovered += it.TotalRecovered
		if it.PricingMode == "time" && it.DailyCost != nil {
			totalDaily += *it.DailyCost
		}
	}

	s.TotalAsset = round2(totalInvested)
	s.TotalInvested = round2(totalInvested)
	s.TotalRecovered = round2(totalRecovered)
	s.NetSpent = round2(totalInvested - totalRecovered)
	s.TotalDailyCost = round2(totalDaily)
	s.TotalMonthlyCost = round2(totalDaily * 30)
	s.TotalYearlyCost = round2(totalDaily * 365)
	return s
}

func sortItems(items []ItemView, sortBy, sortDir string) {
	if sortBy == "" {
		sortBy = "manual"
	}
	desc := strings.ToLower(sortDir) == "desc"

	statusRank := func(st string) int {
		switch st {
		case "favorite":
			return 0
		case "active":
			return 1
		case "retired":
			return 2
		default:
			return 3
		}
	}

	compareOptionalDate := func(a, b *string) int {
		if a == nil && b == nil {
			return 0
		}
		if a == nil {
			return 1 // nil always sinks to the bottom regardless of asc/desc
		}
		if b == nil {
			return -1
		}
		cmp := strings.Compare(*a, *b)
		if desc {
			return -cmp
		}
		return cmp
	}

	compareOptionalFloat := func(a, b *float64) int {
		if a == nil && b == nil {
			return 0
		}
		if a == nil {
			return 1
		}
		if b == nil {
			return -1
		}
		cmp := cmpFloat(*a, *b)
		if desc {
			return -cmp
		}
		return cmp
	}

	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		var cmp int
		switch sortBy {
		case "manual":
			cmp = cmpInt32(a.SortOrder, b.SortOrder)
			if desc {
				cmp = -cmp
			}
		case "created_at":
			cmp = cmpTime(a.CreatedAt, b.CreatedAt)
			if desc {
				cmp = -cmp
			}
		case "updated_at":
			cmp = cmpTime(a.UpdatedAt, b.UpdatedAt)
			if desc {
				cmp = -cmp
			}
		case "price":
			cmp = cmpFloat(a.ConvertedPrice, b.ConvertedPrice)
			if desc {
				cmp = -cmp
			}
		case "daily_cost":
			cmp = compareOptionalFloat(a.DailyCost, b.DailyCost)
		case "usage_count":
			cmp = cmpInt32(a.UsageCount, b.UsageCount)
			if desc {
				cmp = -cmp
			}
		case "holding_days":
			cmp = cmpInt(a.HoldingDays, b.HoldingDays)
			if desc {
				cmp = -cmp
			}
		case "expected_retire_at":
			cmp = compareOptionalDate(a.ExpectedRetireAt, b.ExpectedRetireAt)
		case "warranty_until":
			cmp = compareOptionalDate(a.WarrantyUntil, b.WarrantyUntil)
		case "status_priority":
			cmp = cmpInt(statusRank(a.Status), statusRank(b.Status))
			if desc {
				cmp = -cmp
			}
		default:
			cmp = cmpInt32(a.SortOrder, b.SortOrder)
		}
		if cmp != 0 {
			return cmp < 0
		}
		return a.ID < b.ID
	})
}

func (s *Service) validateItemRefs(
	ctx context.Context,
	userID, selfItemID int64,
	parentID, categoryID, channelID, locationID *int64,
	tagIDs []int64,
) error {
	if parentID != nil {
		if selfItemID != 0 && *parentID == selfItemID {
			return httpx.BadRequest("物品不能将自身设为父物品")
		}
		items, err := s.store.ListItems(ctx, userID)
		if err != nil {
			return err
		}
		parentMap := make(map[int64]*int64, len(items))
		exists := false
		for _, it := range items {
			parentMap[it.ID] = it.ParentID
			if it.ID == *parentID {
				exists = true
			}
		}
		if !exists {
			return httpx.BadRequest("指定的父物品不存在")
		}
		if selfItemID != 0 {
			// Walk up ancestors from parentID to guarantee no cycle back to selfItemID.
			visited := map[int64]bool{selfItemID: true}
			cur := *parentID
			for {
				if visited[cur] {
					return httpx.BadRequest("父子物品归属不能形成循环引用")
				}
				visited[cur] = true
				next, ok := parentMap[cur]
				if !ok || next == nil {
					break
				}
				cur = *next
			}
		}
	}

	if categoryID != nil {
		if _, err := s.store.GetCategory(ctx, userID, *categoryID); err != nil {
			return httpx.BadRequest("指定的分类不存在")
		}
	}
	if channelID != nil {
		if _, err := s.store.GetChannel(ctx, userID, *channelID); err != nil {
			return httpx.BadRequest("指定的购买渠道不存在")
		}
	}
	if locationID != nil {
		if _, err := s.store.GetLocation(ctx, userID, *locationID); err != nil {
			return httpx.BadRequest("指定的存放位置不存在")
		}
	}
	uniqueTags := dedupeIDs(tagIDs)
	if len(uniqueTags) > 0 {
		found, err := s.store.ListTagsByIDs(ctx, userID, uniqueTags)
		if err != nil {
			return err
		}
		if len(found) != len(uniqueTags) {
			return httpx.BadRequest("包含无效的标签")
		}
	}
	return nil
}

// --- Conversion & Validation Helpers ---

func validateCurrency(raw string) (string, error) {
	c := strings.ToUpper(strings.TrimSpace(raw))
	switch c {
	case "CNY", "USD", "EUR":
		return c, nil
	default:
		return "", httpx.BadRequest("仅支持 CNY / USD / EUR 币种")
	}
}

func validatePricingMode(raw string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "time", "usage", "none":
		return strings.TrimSpace(raw), nil
	default:
		return "", httpx.BadRequest("无效的计价方式")
	}
}

func validateStatus(raw string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "active", "favorite", "retired":
		return strings.TrimSpace(raw), nil
	default:
		return "", httpx.BadRequest("无效的物品状态")
	}
}

func validateRetireReason(raw string, required bool) (string, error) {
	r := strings.TrimSpace(raw)
	if r == "" {
		if required {
			return "", httpx.BadRequest("请选择退役原因")
		}
		return "", nil
	}
	switch r {
	case "sold", "gifted", "lost", "expired", "discarded", "other":
		return r, nil
	default:
		return "", httpx.BadRequest("无效的退役原因")
	}
}

func validateTxType(raw string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "expense", "income":
		return strings.TrimSpace(raw), nil
	default:
		return "", httpx.BadRequest("附加收支类型必须是 expense 或 income")
	}
}

func parseDate(raw string) (time.Time, error) {
	t, err := time.Parse(dateLayout, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, err
	}
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC), nil
}

func parseOptionalDatePtr(raw *string) (*time.Time, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	t, err := parseDate(*raw)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func parseTodayDate(raw string) (time.Time, error) {
	if strings.TrimSpace(raw) != "" {
		t, err := parseDate(raw)
		if err != nil {
			return time.Time{}, httpx.BadRequest("today 参数格式无效，应为 YYYY-MM-DD")
		}
		return t, nil
	}
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC), nil
}

func truncateDate(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func formatOptionalDate(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := truncateDate(*t).Format(dateLayout)
	return &s
}

func floatToCents(v float64) int64 {
	return int64(math.Round(v * 100))
}

func centsToFloat(c int64) float64 {
	return float64(c) / 100
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func dedupeIDs(ids []int64) []int64 {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[int64]bool, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id > 0 && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func toSettingsView(r sqlcgen.AssetsUserSetting) UserSettings {
	return UserSettings{
		DisplayCurrency: r.DisplayCurrency,
		CostPeriod:      r.CostPeriod,
		ExcludeRetired:  r.ExcludeRetired,
		HideAmounts:     r.HideAmounts,
		DefaultView:     r.DefaultView,
	}
}

func toCategoryView(r sqlcgen.AssetsCategory) CategoryView {
	return CategoryView{
		ID:        r.ID,
		ParentID:  r.ParentID,
		Name:      r.Name,
		Icon:      r.Icon,
		SortOrder: r.SortOrder,
		CreatedAt: r.CreatedAt,
		UpdatedAt: r.UpdatedAt,
	}
}

func toTagView(r sqlcgen.AssetsTag) TagView {
	return TagView{ID: r.ID, Name: r.Name, Color: r.Color, CreatedAt: r.CreatedAt}
}

func toChannelView(r sqlcgen.AssetsChannel) ChannelView {
	return ChannelView{ID: r.ID, Name: r.Name, CreatedAt: r.CreatedAt}
}

func toLocationView(r sqlcgen.AssetsLocation) LocationView {
	return LocationView{ID: r.ID, Name: r.Name, CreatedAt: r.CreatedAt}
}

func toTransactionView(r sqlcgen.AssetsTransaction, displayCurrency string, rates ExchangeRatesView) TransactionView {
	amt := centsToFloat(r.AmountCents)
	return TransactionView{
		ID:              r.ID,
		ItemID:          r.ItemID,
		Type:            r.Type,
		Amount:          amt,
		Currency:        r.Currency,
		ConvertedAmount: round2(ConvertAmount(amt, r.Currency, displayCurrency, rates)),
		OccurredAt:      truncateDate(r.OccurredAt).Format(dateLayout),
		IncludeInCost:   r.IncludeInCost,
		Note:            r.Note,
		CreatedAt:       r.CreatedAt,
	}
}

func toItemRef(v ItemView) ItemRef {
	return ItemRef{
		ID:              v.ID,
		Name:            v.Name,
		Icon:            v.Icon,
		ImageURL:        v.ImageURL,
		Status:          v.Status,
		Price:           v.Price,
		Currency:        v.Currency,
		TotalInvested:   v.TotalInvested,
		DisplayCurrency: v.DisplayCurrency,
	}
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

func cmpInt32(a, b int32) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

func cmpFloat(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

func cmpTime(a, b time.Time) int {
	switch {
	case a.Before(b):
		return -1
	case a.After(b):
		return 1
	default:
		return 0
	}
}
