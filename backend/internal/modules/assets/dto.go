package assets

import "time"

// UserSettings represents per-user display preferences for the assets workspace.
type UserSettings struct {
	DisplayCurrency string `json:"display_currency" tstype:"'CNY' | 'USD' | 'EUR'"`
	CostPeriod      string `json:"cost_period" tstype:"'daily' | 'monthly' | 'yearly'"`
	ExcludeRetired  bool   `json:"exclude_retired"`
	HideAmounts     bool   `json:"hide_amounts"`
	DefaultView     string `json:"default_view" tstype:"'card' | 'list' | 'folder'"`
}

type UpdateSettingsInput struct {
	DisplayCurrency *string `json:"display_currency,omitempty" tstype:"'CNY' | 'USD' | 'EUR'"`
	CostPeriod      *string `json:"cost_period,omitempty" tstype:"'daily' | 'monthly' | 'yearly'"`
	ExcludeRetired  *bool   `json:"exclude_retired,omitempty"`
	HideAmounts     *bool   `json:"hide_amounts,omitempty"`
	DefaultView     *string `json:"default_view,omitempty" tstype:"'card' | 'list' | 'folder'"`
}

// ExchangeRatesView exposes CNY-based conversion rates (1 CNY -> quote currency).
type ExchangeRatesView struct {
	Base      string             `json:"base" tstype:"'CNY'"`
	Rates     map[string]float64 `json:"rates"`
	Source    string             `json:"source" tstype:"'live' | 'cached' | 'fallback'"`
	FetchedAt time.Time          `json:"fetched_at"`
}

// Metadata models

type CategoryView struct {
	ID        int64     `json:"id"`
	ParentID  *int64    `json:"parent_id,omitempty"`
	Name      string    `json:"name"`
	Icon      string    `json:"icon"`
	SortOrder int32     `json:"sort_order"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type UpsertCategoryInput struct {
	ParentID *int64 `json:"parent_id,omitempty"`
	Name     string `json:"name"`
	Icon     string `json:"icon,omitempty"`
}

type ReorderInput struct {
	IDs []int64 `json:"ids"`
}

type TagView struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
	CreatedAt time.Time `json:"created_at"`
}

type UpsertTagInput struct {
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
}

type ChannelView struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type UpsertChannelInput struct {
	Name string `json:"name"`
}

type LocationView struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type UpsertLocationInput struct {
	Name string `json:"name"`
}

// MetaResponse bundles initial workspace bootstrap data into a single request.
type MetaResponse struct {
	Settings   UserSettings      `json:"settings"`
	Rates      ExchangeRatesView `json:"rates"`
	Categories []CategoryView    `json:"categories"`
	Tags       []TagView         `json:"tags"`
	Channels   []ChannelView     `json:"channels"`
	Locations  []LocationView    `json:"locations"`
}

// Transactions

type TransactionView struct {
	ID              int64     `json:"id"`
	ItemID          int64     `json:"item_id"`
	Type            string    `json:"type" tstype:"'expense' | 'income'"`
	Amount          float64   `json:"amount"`
	Currency        string    `json:"currency" tstype:"'CNY' | 'USD' | 'EUR'"`
	ConvertedAmount float64   `json:"converted_amount"`
	OccurredAt      string    `json:"occurred_at"`
	IncludeInCost   bool      `json:"include_in_cost"`
	Note            string    `json:"note"`
	CreatedAt       time.Time `json:"created_at"`
}

type UpsertTransactionInput struct {
	Type          string  `json:"type" tstype:"'expense' | 'income'"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency,omitempty" tstype:"'CNY' | 'USD' | 'EUR'"`
	OccurredAt    string  `json:"occurred_at,omitempty"` // YYYY-MM-DD
	IncludeInCost *bool   `json:"include_in_cost,omitempty"`
	Note          string  `json:"note,omitempty"`
}

// Items

type UpsertItemInput struct {
	ParentID         *int64  `json:"parent_id,omitempty"`
	CategoryID       *int64  `json:"category_id,omitempty"`
	ChannelID        *int64  `json:"channel_id,omitempty"`
	LocationID       *int64  `json:"location_id,omitempty"`
	Name             string  `json:"name"`
	Icon             string  `json:"icon,omitempty"`
	ImageURL         string  `json:"image_url,omitempty"`
	Price            float64 `json:"price"`
	Currency         string  `json:"currency,omitempty" tstype:"'CNY' | 'USD' | 'EUR'"`
	PurchasedAt      string  `json:"purchased_at,omitempty"` // YYYY-MM-DD
	PricingMode      string  `json:"pricing_mode,omitempty" tstype:"'time' | 'usage' | 'none'"`
	Status           string  `json:"status,omitempty" tstype:"'active' | 'favorite' | 'retired'"`
	ExpectedRetireAt *string `json:"expected_retire_at,omitempty"` // YYYY-MM-DD or empty
	WarrantyUntil    *string `json:"warranty_until,omitempty"`     // YYYY-MM-DD or empty
	UsageCount       *int32  `json:"usage_count,omitempty"`
	Note             string  `json:"note,omitempty"`
	TagIDs           []int64 `json:"tag_ids,omitempty"`
}

type UseItemInput struct {
	Delta int32 `json:"delta"` // default 1; may be negative to undo
}

type RetireItemInput struct {
	RetiredAt    string  `json:"retired_at,omitempty"` // YYYY-MM-DD
	RetireReason string  `json:"retire_reason" tstype:"'sold' | 'gifted' | 'lost' | 'expired' | 'discarded' | 'other'"`
	SoldPrice    float64 `json:"sold_price,omitempty"`
	SoldCurrency string  `json:"sold_currency,omitempty" tstype:"'CNY' | 'USD' | 'EUR'"`
	RetireNote   string  `json:"retire_note,omitempty"`
}

type BatchItemInput struct {
	Action       string  `json:"action" tstype:"'set_category' | 'retire' | 'delete'"`
	ItemIDs      []int64 `json:"item_ids"`
	CategoryID   *int64  `json:"category_id,omitempty"` // nil means uncategorized for set_category
	RetiredAt    string  `json:"retired_at,omitempty"`
	RetireReason string  `json:"retire_reason,omitempty" tstype:"'' | 'sold' | 'gifted' | 'lost' | 'expired' | 'discarded' | 'other'"`
	RetireNote   string  `json:"retire_note,omitempty"`
}

type ItemRef struct {
	ID             int64   `json:"id"`
	Name           string  `json:"name"`
	Icon           string  `json:"icon"`
	ImageURL       string  `json:"image_url"`
	Status         string  `json:"status" tstype:"'active' | 'favorite' | 'retired'"`
	Price          float64 `json:"price"`
	Currency       string  `json:"currency" tstype:"'CNY' | 'USD' | 'EUR'"`
	TotalInvested  float64 `json:"total_invested"`
	DisplayCurrency string `json:"display_currency" tstype:"'CNY' | 'USD' | 'EUR'"`
}

// ItemView is the enriched item returned in list and detail endpoints.
type ItemView struct {
	ID               int64     `json:"id"`
	ParentID         *int64    `json:"parent_id,omitempty"`
	ParentName       string    `json:"parent_name,omitempty"`
	CategoryID       *int64    `json:"category_id,omitempty"`
	CategoryName     string    `json:"category_name,omitempty"`
	ChannelID        *int64    `json:"channel_id,omitempty"`
	ChannelName      string    `json:"channel_name,omitempty"`
	LocationID       *int64    `json:"location_id,omitempty"`
	LocationName     string    `json:"location_name,omitempty"`
	Name             string    `json:"name"`
	Icon             string    `json:"icon"`
	ImageURL         string    `json:"image_url"`
	Price            float64   `json:"price"`
	Currency         string    `json:"currency" tstype:"'CNY' | 'USD' | 'EUR'"`
	ConvertedPrice   float64   `json:"converted_price"`
	DisplayCurrency  string    `json:"display_currency" tstype:"'CNY' | 'USD' | 'EUR'"`
	PurchasedAt      string    `json:"purchased_at"`
	PricingMode      string    `json:"pricing_mode" tstype:"'time' | 'usage' | 'none'"`
	Status           string    `json:"status" tstype:"'active' | 'favorite' | 'retired'"`
	ExpectedRetireAt *string   `json:"expected_retire_at,omitempty"`
	WarrantyUntil    *string   `json:"warranty_until,omitempty"`
	WarrantyDaysLeft *int      `json:"warranty_days_left,omitempty"`
	WarrantyStatus   string    `json:"warranty_status" tstype:"'none' | 'active' | 'expiring_soon' | 'expired'"`
	UsageCount       int32     `json:"usage_count"`
	RetiredAt        *string   `json:"retired_at,omitempty"`
	RetireReason     string    `json:"retire_reason" tstype:"'' | 'sold' | 'gifted' | 'lost' | 'expired' | 'discarded' | 'other'"`
	SoldPrice        float64   `json:"sold_price"`
	SoldCurrency     string    `json:"sold_currency" tstype:"'CNY' | 'USD' | 'EUR'"`
	RetireNote       string    `json:"retire_note"`
	Note             string    `json:"note"`
	SortOrder        int32     `json:"sort_order"`
	Tags             []TagView `json:"tags"`

	// Derived financial & ownership metrics (converted to DisplayCurrency)
	HoldingDays           int      `json:"holding_days"`
	ExtraExpense          float64  `json:"extra_expense"`
	ExtraIncome           float64  `json:"extra_income"`
	TotalInvested         float64  `json:"total_invested"`
	TotalRecovered        float64  `json:"total_recovered"`
	NetSpent              float64  `json:"net_spent"`
	DailyCost             *float64 `json:"daily_cost,omitempty"`
	UsageCost             *float64 `json:"usage_cost,omitempty"`
	ChildrenCount         int      `json:"children_count"`
	ChildrenTotalInvested float64  `json:"children_total_invested"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ItemDetailResponse struct {
	Item         ItemView          `json:"item"`
	Parent       *ItemRef          `json:"parent,omitempty"`
	Children     []ItemRef         `json:"children"`
	Transactions []TransactionView `json:"transactions"`
	Rates        ExchangeRatesView `json:"rates"`
}

type SummaryView struct {
	DisplayCurrency       string  `json:"display_currency" tstype:"'CNY' | 'USD' | 'EUR'"`
	TotalAsset            float64 `json:"total_asset"`
	TotalCount            int     `json:"total_count"`
	TotalInvested         float64 `json:"total_invested"`
	TotalRecovered        float64 `json:"total_recovered"`
	NetSpent              float64 `json:"net_spent"`
	TotalDailyCost        float64 `json:"total_daily_cost"`
	TotalMonthlyCost      float64 `json:"total_monthly_cost"`
	TotalYearlyCost       float64 `json:"total_yearly_cost"`
	WarrantyExpiringCount int     `json:"warranty_expiring_count"`
	WarrantyExpiredCount  int     `json:"warranty_expired_count"`
}

type ListItemsResponse struct {
	Items   []ItemView        `json:"items"`
	Summary SummaryView       `json:"summary"`
	Rates   ExchangeRatesView `json:"rates"`
}
