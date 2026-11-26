package assets

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/core/httpx"
	"yukideck/internal/modules/assets/sqlcgen"
)

// Store abstracts persistence for the assets module so business logic can be unit-tested in memory.
type Store interface {
	// Settings & seeding
	EnsureUserSettings(ctx context.Context, userID int64) (sqlcgen.AssetsUserSetting, error)
	SeedDefaultCategories(ctx context.Context, userID int64, seeds []SeedCategory) error
	UpsertUserSettings(ctx context.Context, arg sqlcgen.UpsertUserSettingsParams) (sqlcgen.AssetsUserSetting, error)

	// Categories
	ListCategories(ctx context.Context, userID int64) ([]sqlcgen.AssetsCategory, error)
	GetCategory(ctx context.Context, userID, id int64) (sqlcgen.AssetsCategory, error)
	CountChildCategories(ctx context.Context, userID, parentID int64) (int64, error)
	CreateCategory(ctx context.Context, userID int64, parentID *int64, name, icon string) (sqlcgen.AssetsCategory, error)
	UpdateCategory(ctx context.Context, userID, id int64, parentID *int64, name, icon string) (sqlcgen.AssetsCategory, error)
	ReorderCategories(ctx context.Context, userID int64, ids []int64) error
	DeleteCategory(ctx context.Context, userID, id int64) error

	// Tags
	ListTags(ctx context.Context, userID int64) ([]sqlcgen.AssetsTag, error)
	ListTagsByIDs(ctx context.Context, userID int64, ids []int64) ([]sqlcgen.AssetsTag, error)
	CreateTag(ctx context.Context, userID int64, name, color string) (sqlcgen.AssetsTag, error)
	UpdateTag(ctx context.Context, userID, id int64, name, color string) (sqlcgen.AssetsTag, error)
	DeleteTag(ctx context.Context, userID, id int64) error

	// Channels
	ListChannels(ctx context.Context, userID int64) ([]sqlcgen.AssetsChannel, error)
	GetChannel(ctx context.Context, userID, id int64) (sqlcgen.AssetsChannel, error)
	CreateChannel(ctx context.Context, userID int64, name string) (sqlcgen.AssetsChannel, error)
	UpdateChannel(ctx context.Context, userID, id int64, name string) (sqlcgen.AssetsChannel, error)
	DeleteChannel(ctx context.Context, userID, id int64) error

	// Locations
	ListLocations(ctx context.Context, userID int64) ([]sqlcgen.AssetsLocation, error)
	GetLocation(ctx context.Context, userID, id int64) (sqlcgen.AssetsLocation, error)
	CreateLocation(ctx context.Context, userID int64, name string) (sqlcgen.AssetsLocation, error)
	UpdateLocation(ctx context.Context, userID, id int64, name string) (sqlcgen.AssetsLocation, error)
	DeleteLocation(ctx context.Context, userID, id int64) error

	// Items
	ListItems(ctx context.Context, userID int64) ([]sqlcgen.AssetsItem, error)
	GetItem(ctx context.Context, userID, id int64) (sqlcgen.AssetsItem, error)
	CreateItemWithTags(ctx context.Context, arg sqlcgen.CreateItemParams, tagIDs []int64) (sqlcgen.AssetsItem, error)
	UpdateItemWithTags(ctx context.Context, arg sqlcgen.UpdateItemParams, tagIDs []int64) (sqlcgen.AssetsItem, error)
	DeleteItem(ctx context.Context, userID, id int64) error
	AdjustItemUsageCount(ctx context.Context, userID, id int64, delta int32) (sqlcgen.AssetsItem, error)
	RetireItem(ctx context.Context, arg sqlcgen.RetireItemParams) (sqlcgen.AssetsItem, error)
	UnretireItem(ctx context.Context, userID, id int64) (sqlcgen.AssetsItem, error)
	ReorderItems(ctx context.Context, userID int64, ids []int64) error
	BatchSetItemCategory(ctx context.Context, userID int64, categoryID *int64, ids []int64) (int64, error)
	BatchRetireItems(ctx context.Context, arg sqlcgen.BatchRetireItemsParams) (int64, error)
	BatchDeleteItems(ctx context.Context, userID int64, ids []int64) (int64, error)

	// Item tags
	ListItemTagsByUser(ctx context.Context, userID int64) ([]sqlcgen.AssetsItemTag, error)

	// Transactions
	ListTransactionsByUser(ctx context.Context, userID int64) ([]sqlcgen.AssetsTransaction, error)
	ListTransactionsByItem(ctx context.Context, userID, itemID int64) ([]sqlcgen.AssetsTransaction, error)
	CreateTransaction(ctx context.Context, arg sqlcgen.CreateTransactionParams) (sqlcgen.AssetsTransaction, error)
	UpdateTransaction(ctx context.Context, arg sqlcgen.UpdateTransactionParams) (sqlcgen.AssetsTransaction, error)
	DeleteTransaction(ctx context.Context, userID, itemID, id int64) error

	// Exchange rates
	ListExchangeRates(ctx context.Context, baseCurrency string) ([]sqlcgen.AssetsExchangeRate, error)
	UpsertExchangeRate(ctx context.Context, arg sqlcgen.UpsertExchangeRateParams) error
}

type PGStore struct {
	pool *pgxpool.Pool
	q    *sqlcgen.Queries
}

func NewPGStore(pool *pgxpool.Pool) *PGStore {
	return &PGStore{pool: pool, q: sqlcgen.New(pool)}
}

func mapPGError(err error, notFoundMsg, conflictMsg string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound(notFoundMsg)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return httpx.Conflict(conflictMsg)
	}
	return httpx.Internal("数据库操作失败", err)
}

func (s *PGStore) EnsureUserSettings(ctx context.Context, userID int64) (sqlcgen.AssetsUserSetting, error) {
	if err := s.q.InsertDefaultUserSettings(ctx, userID); err != nil {
		return sqlcgen.AssetsUserSetting{}, httpx.Internal("初始化偏好失败", err)
	}
	row, err := s.q.GetUserSettings(ctx, userID)
	if err != nil {
		return sqlcgen.AssetsUserSetting{}, mapPGError(err, "用户偏好不存在", "用户偏好冲突")
	}
	return row, nil
}

func (s *PGStore) SeedDefaultCategories(ctx context.Context, userID int64, seeds []SeedCategory) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpx.Internal("开启事务失败", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.q.WithTx(tx)
	settings, err := qtx.GetUserSettings(ctx, userID)
	if err != nil {
		return mapPGError(err, "用户偏好不存在", "用户偏好冲突")
	}
	if settings.SeededCategories {
		return nil
	}

	for i, cat := range seeds {
		parent, err := qtx.CreateCategory(ctx, sqlcgen.CreateCategoryParams{
			UserID:    userID,
			ParentID:  nil,
			Name:      cat.Name,
			Icon:      cat.Icon,
			SortOrder: int32(i),
		})
		if err != nil {
			return httpx.Internal("初始化默认分类失败", err)
		}
		pid := parent.ID
		for j, child := range cat.Children {
			if _, err := qtx.CreateCategory(ctx, sqlcgen.CreateCategoryParams{
				UserID:    userID,
				ParentID:  &pid,
				Name:      child.Name,
				Icon:      child.Icon,
				SortOrder: int32(j),
			}); err != nil {
				return httpx.Internal("初始化默认子分类失败", err)
			}
		}
	}

	if err := qtx.MarkCategoriesSeeded(ctx, userID); err != nil {
		return httpx.Internal("标记默认分类状态失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return httpx.Internal("提交默认分类事务失败", err)
	}
	return nil
}

func (s *PGStore) UpsertUserSettings(ctx context.Context, arg sqlcgen.UpsertUserSettingsParams) (sqlcgen.AssetsUserSetting, error) {
	row, err := s.q.UpsertUserSettings(ctx, arg)
	if err != nil {
		return sqlcgen.AssetsUserSetting{}, httpx.Internal("保存偏好失败", err)
	}
	return row, nil
}

func (s *PGStore) ListCategories(ctx context.Context, userID int64) ([]sqlcgen.AssetsCategory, error) {
	rows, err := s.q.ListCategories(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询分类失败", err)
	}
	return rows, nil
}

func (s *PGStore) GetCategory(ctx context.Context, userID, id int64) (sqlcgen.AssetsCategory, error) {
	row, err := s.q.GetCategory(ctx, sqlcgen.GetCategoryParams{UserID: userID, ID: id})
	if err != nil {
		return sqlcgen.AssetsCategory{}, mapPGError(err, "分类不存在", "分类名称重复")
	}
	return row, nil
}

func (s *PGStore) CountChildCategories(ctx context.Context, userID, parentID int64) (int64, error) {
	pid := parentID
	count, err := s.q.CountChildCategories(ctx, sqlcgen.CountChildCategoriesParams{UserID: userID, ParentID: &pid})
	if err != nil {
		return 0, httpx.Internal("查询子分类失败", err)
	}
	return count, nil
}

func (s *PGStore) CreateCategory(ctx context.Context, userID int64, parentID *int64, name, icon string) (sqlcgen.AssetsCategory, error) {
	maxOrder, err := s.q.MaxCategorySortOrder(ctx, sqlcgen.MaxCategorySortOrderParams{
		UserID:   userID,
		ParentID: parentID,
	})
	if err != nil {
		return sqlcgen.AssetsCategory{}, httpx.Internal("计算分类排序失败", err)
	}
	row, err := s.q.CreateCategory(ctx, sqlcgen.CreateCategoryParams{
		UserID:    userID,
		ParentID:  parentID,
		Name:      name,
		Icon:      icon,
		SortOrder: maxOrder + 1,
	})
	if err != nil {
		return sqlcgen.AssetsCategory{}, mapPGError(err, "分类不存在", "分类已存在")
	}
	return row, nil
}

func (s *PGStore) UpdateCategory(ctx context.Context, userID, id int64, parentID *int64, name, icon string) (sqlcgen.AssetsCategory, error) {
	row, err := s.q.UpdateCategory(ctx, sqlcgen.UpdateCategoryParams{
		UserID:   userID,
		ID:       id,
		ParentID: parentID,
		Name:     name,
		Icon:     icon,
	})
	if err != nil {
		return sqlcgen.AssetsCategory{}, mapPGError(err, "分类不存在", "分类已存在")
	}
	return row, nil
}

func (s *PGStore) ReorderCategories(ctx context.Context, userID int64, ids []int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpx.Internal("开启排序事务失败", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := s.q.WithTx(tx)
	for idx, id := range ids {
		if err := qtx.UpdateCategorySortOrder(ctx, sqlcgen.UpdateCategorySortOrderParams{
			UserID:    userID,
			ID:        id,
			SortOrder: int32(idx),
		}); err != nil {
			return httpx.Internal("更新分类排序失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return httpx.Internal("提交分类排序失败", err)
	}
	return nil
}

func (s *PGStore) DeleteCategory(ctx context.Context, userID, id int64) error {
	n, err := s.q.DeleteCategory(ctx, sqlcgen.DeleteCategoryParams{UserID: userID, ID: id})
	if err != nil {
		return httpx.Internal("删除分类失败", err)
	}
	if n == 0 {
		return httpx.NotFound("分类不存在")
	}
	return nil
}

func (s *PGStore) ListTags(ctx context.Context, userID int64) ([]sqlcgen.AssetsTag, error) {
	rows, err := s.q.ListTags(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询标签失败", err)
	}
	return rows, nil
}

func (s *PGStore) ListTagsByIDs(ctx context.Context, userID int64, ids []int64) ([]sqlcgen.AssetsTag, error) {
	if len(ids) == 0 {
		return []sqlcgen.AssetsTag{}, nil
	}
	rows, err := s.q.ListTagsByIDs(ctx, sqlcgen.ListTagsByIDsParams{UserID: userID, Column2: ids})
	if err != nil {
		return nil, httpx.Internal("查询标签失败", err)
	}
	return rows, nil
}

func (s *PGStore) CreateTag(ctx context.Context, userID int64, name, color string) (sqlcgen.AssetsTag, error) {
	row, err := s.q.CreateTag(ctx, sqlcgen.CreateTagParams{UserID: userID, Name: name, Color: color})
	if err != nil {
		return sqlcgen.AssetsTag{}, mapPGError(err, "标签不存在", "同名标签已存在")
	}
	return row, nil
}

func (s *PGStore) UpdateTag(ctx context.Context, userID, id int64, name, color string) (sqlcgen.AssetsTag, error) {
	row, err := s.q.UpdateTag(ctx, sqlcgen.UpdateTagParams{UserID: userID, ID: id, Name: name, Color: color})
	if err != nil {
		return sqlcgen.AssetsTag{}, mapPGError(err, "标签不存在", "同名标签已存在")
	}
	return row, nil
}

func (s *PGStore) DeleteTag(ctx context.Context, userID, id int64) error {
	n, err := s.q.DeleteTag(ctx, sqlcgen.DeleteTagParams{UserID: userID, ID: id})
	if err != nil {
		return httpx.Internal("删除标签失败", err)
	}
	if n == 0 {
		return httpx.NotFound("标签不存在")
	}
	return nil
}

func (s *PGStore) ListChannels(ctx context.Context, userID int64) ([]sqlcgen.AssetsChannel, error) {
	rows, err := s.q.ListChannels(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询渠道失败", err)
	}
	return rows, nil
}

func (s *PGStore) GetChannel(ctx context.Context, userID, id int64) (sqlcgen.AssetsChannel, error) {
	row, err := s.q.GetChannel(ctx, sqlcgen.GetChannelParams{UserID: userID, ID: id})
	if err != nil {
		return sqlcgen.AssetsChannel{}, mapPGError(err, "购买渠道不存在", "同名渠道已存在")
	}
	return row, nil
}

func (s *PGStore) CreateChannel(ctx context.Context, userID int64, name string) (sqlcgen.AssetsChannel, error) {
	row, err := s.q.CreateChannel(ctx, sqlcgen.CreateChannelParams{UserID: userID, Name: name})
	if err != nil {
		return sqlcgen.AssetsChannel{}, mapPGError(err, "购买渠道不存在", "同名渠道已存在")
	}
	return row, nil
}

func (s *PGStore) UpdateChannel(ctx context.Context, userID, id int64, name string) (sqlcgen.AssetsChannel, error) {
	row, err := s.q.UpdateChannel(ctx, sqlcgen.UpdateChannelParams{UserID: userID, ID: id, Name: name})
	if err != nil {
		return sqlcgen.AssetsChannel{}, mapPGError(err, "购买渠道不存在", "同名渠道已存在")
	}
	return row, nil
}

func (s *PGStore) DeleteChannel(ctx context.Context, userID, id int64) error {
	n, err := s.q.DeleteChannel(ctx, sqlcgen.DeleteChannelParams{UserID: userID, ID: id})
	if err != nil {
		return httpx.Internal("删除渠道失败", err)
	}
	if n == 0 {
		return httpx.NotFound("购买渠道不存在")
	}
	return nil
}

func (s *PGStore) ListLocations(ctx context.Context, userID int64) ([]sqlcgen.AssetsLocation, error) {
	rows, err := s.q.ListLocations(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询存放位置失败", err)
	}
	return rows, nil
}

func (s *PGStore) GetLocation(ctx context.Context, userID, id int64) (sqlcgen.AssetsLocation, error) {
	row, err := s.q.GetLocation(ctx, sqlcgen.GetLocationParams{UserID: userID, ID: id})
	if err != nil {
		return sqlcgen.AssetsLocation{}, mapPGError(err, "存放位置不存在", "同名位置已存在")
	}
	return row, nil
}

func (s *PGStore) CreateLocation(ctx context.Context, userID int64, name string) (sqlcgen.AssetsLocation, error) {
	row, err := s.q.CreateLocation(ctx, sqlcgen.CreateLocationParams{UserID: userID, Name: name})
	if err != nil {
		return sqlcgen.AssetsLocation{}, mapPGError(err, "存放位置不存在", "同名位置已存在")
	}
	return row, nil
}

func (s *PGStore) UpdateLocation(ctx context.Context, userID, id int64, name string) (sqlcgen.AssetsLocation, error) {
	row, err := s.q.UpdateLocation(ctx, sqlcgen.UpdateLocationParams{UserID: userID, ID: id, Name: name})
	if err != nil {
		return sqlcgen.AssetsLocation{}, mapPGError(err, "存放位置不存在", "同名位置已存在")
	}
	return row, nil
}

func (s *PGStore) DeleteLocation(ctx context.Context, userID, id int64) error {
	n, err := s.q.DeleteLocation(ctx, sqlcgen.DeleteLocationParams{UserID: userID, ID: id})
	if err != nil {
		return httpx.Internal("删除存放位置失败", err)
	}
	if n == 0 {
		return httpx.NotFound("存放位置不存在")
	}
	return nil
}

func (s *PGStore) ListItems(ctx context.Context, userID int64) ([]sqlcgen.AssetsItem, error) {
	rows, err := s.q.ListItems(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询物品列表失败", err)
	}
	return rows, nil
}

func (s *PGStore) GetItem(ctx context.Context, userID, id int64) (sqlcgen.AssetsItem, error) {
	row, err := s.q.GetItem(ctx, sqlcgen.GetItemParams{UserID: userID, ID: id})
	if err != nil {
		return sqlcgen.AssetsItem{}, mapPGError(err, "物品不存在", "物品冲突")
	}
	return row, nil
}

func (s *PGStore) CreateItemWithTags(ctx context.Context, arg sqlcgen.CreateItemParams, tagIDs []int64) (sqlcgen.AssetsItem, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return sqlcgen.AssetsItem{}, httpx.Internal("开启事务失败", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.q.WithTx(tx)
	maxOrder, err := qtx.MaxItemSortOrder(ctx, arg.UserID)
	if err != nil {
		return sqlcgen.AssetsItem{}, httpx.Internal("计算物品排序失败", err)
	}
	arg.SortOrder = maxOrder + 1

	item, err := qtx.CreateItem(ctx, arg)
	if err != nil {
		return sqlcgen.AssetsItem{}, mapPGError(err, "创建物品失败", "物品冲突")
	}
	for _, tid := range tagIDs {
		if err := qtx.InsertItemTag(ctx, sqlcgen.InsertItemTagParams{ItemID: item.ID, TagID: tid}); err != nil {
			return sqlcgen.AssetsItem{}, httpx.Internal("关联物品标签失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return sqlcgen.AssetsItem{}, httpx.Internal("提交事务失败", err)
	}
	return item, nil
}

func (s *PGStore) UpdateItemWithTags(ctx context.Context, arg sqlcgen.UpdateItemParams, tagIDs []int64) (sqlcgen.AssetsItem, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return sqlcgen.AssetsItem{}, httpx.Internal("开启事务失败", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.q.WithTx(tx)
	item, err := qtx.UpdateItem(ctx, arg)
	if err != nil {
		return sqlcgen.AssetsItem{}, mapPGError(err, "物品不存在", "物品冲突")
	}
	if tagIDs != nil {
		if err := qtx.DeleteItemTags(ctx, item.ID); err != nil {
			return sqlcgen.AssetsItem{}, httpx.Internal("清理物品标签失败", err)
		}
		for _, tid := range tagIDs {
			if err := qtx.InsertItemTag(ctx, sqlcgen.InsertItemTagParams{ItemID: item.ID, TagID: tid}); err != nil {
				return sqlcgen.AssetsItem{}, httpx.Internal("关联物品标签失败", err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return sqlcgen.AssetsItem{}, httpx.Internal("提交事务失败", err)
	}
	return item, nil
}

func (s *PGStore) DeleteItem(ctx context.Context, userID, id int64) error {
	n, err := s.q.DeleteItem(ctx, sqlcgen.DeleteItemParams{UserID: userID, ID: id})
	if err != nil {
		return httpx.Internal("删除物品失败", err)
	}
	if n == 0 {
		return httpx.NotFound("物品不存在")
	}
	return nil
}

func (s *PGStore) AdjustItemUsageCount(ctx context.Context, userID, id int64, delta int32) (sqlcgen.AssetsItem, error) {
	row, err := s.q.AdjustItemUsageCount(ctx, sqlcgen.AdjustItemUsageCountParams{
		UserID:     userID,
		ID:         id,
		UsageCount: delta,
	})
	if err != nil {
		return sqlcgen.AssetsItem{}, mapPGError(err, "物品不存在", "更新失败")
	}
	return row, nil
}

func (s *PGStore) RetireItem(ctx context.Context, arg sqlcgen.RetireItemParams) (sqlcgen.AssetsItem, error) {
	row, err := s.q.RetireItem(ctx, arg)
	if err != nil {
		return sqlcgen.AssetsItem{}, mapPGError(err, "物品不存在", "更新失败")
	}
	return row, nil
}

func (s *PGStore) UnretireItem(ctx context.Context, userID, id int64) (sqlcgen.AssetsItem, error) {
	row, err := s.q.UnretireItem(ctx, sqlcgen.UnretireItemParams{UserID: userID, ID: id})
	if err != nil {
		return sqlcgen.AssetsItem{}, mapPGError(err, "物品不存在", "更新失败")
	}
	return row, nil
}

func (s *PGStore) ReorderItems(ctx context.Context, userID int64, ids []int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpx.Internal("开启排序事务失败", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := s.q.WithTx(tx)
	for idx, id := range ids {
		if err := qtx.UpdateItemSortOrder(ctx, sqlcgen.UpdateItemSortOrderParams{
			UserID:    userID,
			ID:        id,
			SortOrder: int32(idx),
		}); err != nil {
			return httpx.Internal("更新物品排序失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return httpx.Internal("提交排序事务失败", err)
	}
	return nil
}

func (s *PGStore) BatchSetItemCategory(ctx context.Context, userID int64, categoryID *int64, ids []int64) (int64, error) {
	n, err := s.q.BatchSetItemCategory(ctx, sqlcgen.BatchSetItemCategoryParams{
		UserID:     userID,
		CategoryID: categoryID,
		Column3:    ids,
	})
	if err != nil {
		return 0, httpx.Internal("批量修改分类失败", err)
	}
	return n, nil
}

func (s *PGStore) BatchRetireItems(ctx context.Context, arg sqlcgen.BatchRetireItemsParams) (int64, error) {
	n, err := s.q.BatchRetireItems(ctx, arg)
	if err != nil {
		return 0, httpx.Internal("批量退役失败", err)
	}
	return n, nil
}

func (s *PGStore) BatchDeleteItems(ctx context.Context, userID int64, ids []int64) (int64, error) {
	n, err := s.q.BatchDeleteItems(ctx, sqlcgen.BatchDeleteItemsParams{UserID: userID, Column2: ids})
	if err != nil {
		return 0, httpx.Internal("批量删除失败", err)
	}
	return n, nil
}

func (s *PGStore) ListItemTagsByUser(ctx context.Context, userID int64) ([]sqlcgen.AssetsItemTag, error) {
	rows, err := s.q.ListItemTagsByUser(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询物品标签失败", err)
	}
	return rows, nil
}

func (s *PGStore) ListTransactionsByUser(ctx context.Context, userID int64) ([]sqlcgen.AssetsTransaction, error) {
	rows, err := s.q.ListTransactionsByUser(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询附加收支失败", err)
	}
	return rows, nil
}

func (s *PGStore) ListTransactionsByItem(ctx context.Context, userID, itemID int64) ([]sqlcgen.AssetsTransaction, error) {
	rows, err := s.q.ListTransactionsByItem(ctx, sqlcgen.ListTransactionsByItemParams{
		UserID: userID,
		ItemID: itemID,
	})
	if err != nil {
		return nil, httpx.Internal("查询附加收支失败", err)
	}
	return rows, nil
}

func (s *PGStore) CreateTransaction(ctx context.Context, arg sqlcgen.CreateTransactionParams) (sqlcgen.AssetsTransaction, error) {
	row, err := s.q.CreateTransaction(ctx, arg)
	if err != nil {
		return sqlcgen.AssetsTransaction{}, mapPGError(err, "物品不存在", "收支记录冲突")
	}
	return row, nil
}

func (s *PGStore) UpdateTransaction(ctx context.Context, arg sqlcgen.UpdateTransactionParams) (sqlcgen.AssetsTransaction, error) {
	row, err := s.q.UpdateTransaction(ctx, arg)
	if err != nil {
		return sqlcgen.AssetsTransaction{}, mapPGError(err, "附加收支记录不存在", "收支记录冲突")
	}
	return row, nil
}

func (s *PGStore) DeleteTransaction(ctx context.Context, userID, itemID, id int64) error {
	n, err := s.q.DeleteTransaction(ctx, sqlcgen.DeleteTransactionParams{
		UserID: userID,
		ItemID: itemID,
		ID:     id,
	})
	if err != nil {
		return httpx.Internal("删除附加收支失败", err)
	}
	if n == 0 {
		return httpx.NotFound("附加收支记录不存在")
	}
	return nil
}

func (s *PGStore) ListExchangeRates(ctx context.Context, baseCurrency string) ([]sqlcgen.AssetsExchangeRate, error) {
	return s.q.ListExchangeRates(ctx, baseCurrency)
}

func (s *PGStore) UpsertExchangeRate(ctx context.Context, arg sqlcgen.UpsertExchangeRateParams) error {
	return s.q.UpsertExchangeRate(ctx, arg)
}
