package assets

// SeedCategory defines one built-in top-level category and its optional subcategories
// seeded once when a user opens the assets module for the first time.
type SeedCategory struct {
	Name     string
	Icon     string
	Children []SeedSubCategory
}

type SeedSubCategory struct {
	Name string
	Icon string
}

var defaultSeedCategories = []SeedCategory{
	{
		Name: "数码电子",
		Icon: "smartphone",
		Children: []SeedSubCategory{
			{Name: "手机", Icon: "smartphone"},
			{Name: "电脑平板", Icon: "laptop"},
			{Name: "耳机音频", Icon: "headphones"},
			{Name: "摄影器材", Icon: "camera"},
			{Name: "外设配件", Icon: "keyboard"},
		},
	},
	{
		Name: "家用电器",
		Icon: "tv",
		Children: []SeedSubCategory{
			{Name: "生活家电", Icon: "fan"},
			{Name: "厨房电器", Icon: "coffee"},
			{Name: "个护电器", Icon: "sparkles"},
		},
	},
	{
		Name: "居家日用",
		Icon: "home",
		Children: []SeedSubCategory{
			{Name: "家具家居", Icon: "armchair"},
			{Name: "收纳工具", Icon: "wrench"},
			{Name: "办公文具", Icon: "pen-tool"},
		},
	},
	{
		Name: "服饰鞋包",
		Icon: "shirt",
		Children: []SeedSubCategory{
			{Name: "服装", Icon: "shirt"},
			{Name: "鞋靴", Icon: "footprints"},
			{Name: "箱包", Icon: "briefcase"},
			{Name: "配饰", Icon: "watch"},
		},
	},
	{
		Name: "运动户外",
		Icon: "bike",
		Children: []SeedSubCategory{
			{Name: "健身器材", Icon: "dumbbell"},
			{Name: "骑行装备", Icon: "bike"},
			{Name: "露营户外", Icon: "tent"},
		},
	},
	{
		Name: "交通出行",
		Icon: "car",
		Children: []SeedSubCategory{
			{Name: "车辆代步", Icon: "car"},
			{Name: "车载配件", Icon: "compass"},
		},
	},
	{
		Name: "兴趣收藏",
		Icon: "gamepad-2",
		Children: []SeedSubCategory{
			{Name: "游戏主机", Icon: "gamepad-2"},
			{Name: "乐器", Icon: "music"},
			{Name: "图书手办", Icon: "book-open"},
		},
	},
}
