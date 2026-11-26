import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Layers,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { Select } from '@/components/Select';
import { Tooltip } from '@/components/Tooltip';
import {
  CURRENCY_OPTIONS,
  PRICING_MODE_LABELS,
  RETIRE_REASON_LABELS,
  assetsApi,
  buildCategorySelectOptions,
  formatMoney,
  getLocalTodayString,
  type AssetCategory,
  type AssetChannel,
  type AssetItem,
  type AssetLocation,
  type AssetTag,
  type Currency,
  type ItemStatus,
  type PricingMode,
  type RetireItemInput,
  type RetireReason,
  type UpsertItemInput,
} from '../api';
import { AssetIcon, AssetVisual, IconPicker } from './IconPicker';

const PRICING_MODE_OPTIONS = (Object.entries(PRICING_MODE_LABELS) as [PricingMode, string][]).map(
  ([value, label]) => ({ value, label }),
);

const RETIRE_REASON_OPTIONS = (Object.entries(RETIRE_REASON_LABELS) as [RetireReason, string][]).map(
  ([value, label]) => ({ value, label }),
);

const TX_TYPE_OPTIONS = [
  { value: 'expense', label: '附加支出' },
  { value: 'income', label: '附加收入' },
];

// ============================================================================
// 1. RetireModal (Single or Batch)
// ============================================================================

export function RetireModal({
  open,
  title,
  defaultCurrency,
  showSoldPrice = true,
  submitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  defaultCurrency: Currency;
  showSoldPrice?: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (payload: RetireItemInput) => void;
}) {
  const [retiredAt, setRetiredAt] = useState(getLocalTodayString());
  const [reason, setReason] = useState<RetireReason>('sold');
  const [soldPrice, setSoldPrice] = useState('');
  const [soldCurrency, setSoldCurrency] = useState<Currency>(defaultCurrency);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setRetiredAt(getLocalTodayString());
      setReason('sold');
      setSoldPrice('');
      setSoldCurrency(defaultCurrency);
      setNote('');
    }
  }, [open, defaultCurrency]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/15 p-4 backdrop-blur-[2px]"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            retired_at: retiredAt,
            retire_reason: reason,
            sold_price: showSoldPrice ? Number(soldPrice) || 0 : 0,
            sold_currency: soldCurrency,
            retire_note: note.trim(),
          });
        }}
        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
          <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
          <button type="button" onClick={onClose} className="yd-btn-icon">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="yd-label">退役日期</span>
              <input
                type="date"
                value={retiredAt}
                onChange={(e) => setRetiredAt(e.target.value)}
                className="yd-input"
              />
            </label>
            <div className="space-y-1.5">
              <span className="yd-label block">退役原因</span>
              <Select
                value={reason}
                onChange={(v) => setReason(v as RetireReason)}
                options={RETIRE_REASON_OPTIONS}
                size="md"
                searchable={false}
                className="w-full"
                ariaLabel="选择退役原因"
              />
            </div>
          </div>

          {showSoldPrice && (
            <div className="grid grid-cols-3 gap-2.5">
              <label className="col-span-2 block space-y-1.5">
                <span className="yd-label">出售 / 回收所得</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={soldPrice}
                  onChange={(e) => setSoldPrice(e.target.value)}
                  placeholder="0.00"
                  className="yd-input font-mono"
                />
              </label>
              <div className="space-y-1.5">
                <span className="yd-label block">币种</span>
                <Select
                  value={soldCurrency}
                  onChange={(v) => setSoldCurrency(v as Currency)}
                  options={CURRENCY_OPTIONS}
                  size="md"
                  searchable={false}
                  className="w-full"
                  ariaLabel="选择出售币种"
                />
              </div>
            </div>
          )}

          <label className="block space-y-1.5">
            <span className="yd-label">退役说明</span>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：闲鱼出掉、送给朋友等"
              className="yd-input resize-none"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50/50 px-6 py-3.5">
          <button type="button" onClick={onClose} className="yd-btn-secondary">
            取消
          </button>
          <button type="submit" disabled={submitting} className="yd-btn-primary">
            {submitting ? '提交中...' : '确认退役'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================================
// 2. Unified ItemModal (Quick Entry + "更多" Expandable Full Entry & Detail)
//    Aligned with planner/ItemModal.tsx interaction pattern
// ============================================================================

export function ItemModal({
  open,
  itemId,
  allItems,
  defaultCurrency,
  hideAmounts,
  categories,
  tags,
  channels,
  locations,
  onClose,
  onSelectItem,
  onMutated,
}: {
  open: boolean;
  itemId: number | null; // null = create (compact by default with "更多" toggle)
  allItems: AssetItem[];
  defaultCurrency: Currency;
  hideAmounts: boolean;
  categories: AssetCategory[];
  tags: AssetTag[];
  channels: AssetChannel[];
  locations: AssetLocation[];
  onClose: () => void;
  onSelectItem: (id: number) => void;
  onMutated: (msg?: string) => void;
}) {
  const qc = useQueryClient();
  const isEdit = itemId !== null;

  const { data: detail, isLoading } = useQuery({
    queryKey: ['assets', 'detail', itemId, defaultCurrency],
    queryFn: () => assetsApi.getItemDetail(itemId!, defaultCurrency),
    enabled: open && isEdit,
  });

  // Progressive disclosure toggle: compact for new item, expanded for existing item
  const [showMore, setShowMore] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('package');
  const [imageUrl, setImageUrl] = useState('');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [purchasedAt, setPurchasedAt] = useState(getLocalTodayString());
  const [pricingMode, setPricingMode] = useState<PricingMode>('time');
  const [status, setStatus] = useState<ItemStatus>('active');
  const [categoryId, setCategoryId] = useState<string>('');
  const [channelId, setChannelId] = useState<string>('');
  const [locationId, setLocationId] = useState<string>('');
  const [parentId, setParentId] = useState<string>('');
  const [expectedRetireAt, setExpectedRetireAt] = useState('');
  const [warrantyUntil, setWarrantyUntil] = useState('');
  const [usageCount, setUsageCount] = useState('0');
  const [note, setNote] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [errMsg, setErrMsg] = useState('');

  // Inline quick-add metadata inputs
  const [newChannelName, setNewChannelName] = useState('');
  const [newLocationName, setNewLocationName] = useState('');
  const [newTagName, setNewTagName] = useState('');

  // Transaction form state
  const [txType, setTxType] = useState<'expense' | 'income'>('expense');
  const [txAmount, setTxAmount] = useState('');
  const [txCurrency, setTxCurrency] = useState<Currency>(defaultCurrency);
  const [txDate, setTxDate] = useState(getLocalTodayString());
  const [txInclude, setTxInclude] = useState(true);
  const [txNote, setTxNote] = useState('');

  // Retire modal state
  const [retireOpen, setRetireOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrMsg('');
    setIconPickerOpen(false);
    setNewChannelName('');
    setNewLocationName('');
    setNewTagName('');
    if (!isEdit) {
      setShowMore(false);
      setName('');
      setIcon('package');
      setImageUrl('');
      setPrice('');
      setCurrency(defaultCurrency);
      setPurchasedAt(getLocalTodayString());
      setPricingMode('time');
      setStatus('active');
      setCategoryId('');
      setChannelId('');
      setLocationId('');
      setParentId('');
      setExpectedRetireAt('');
      setWarrantyUntil('');
      setUsageCount('0');
      setNote('');
      setSelectedTagIds([]);
    } else {
      setShowMore(true);
      if (detail?.item) {
        const it = detail.item;
        setName(it.name);
        setIcon(it.icon || 'package');
        setImageUrl(it.image_url || '');
        setPrice(String(it.price));
        setCurrency(it.currency);
        setPurchasedAt(it.purchased_at);
        setPricingMode(it.pricing_mode);
        setStatus(it.status);
        setCategoryId(it.category_id ? String(it.category_id) : '');
        setChannelId(it.channel_id ? String(it.channel_id) : '');
        setLocationId(it.location_id ? String(it.location_id) : '');
        setParentId(it.parent_id ? String(it.parent_id) : '');
        setExpectedRetireAt(it.expected_retire_at ?? '');
        setWarrantyUntil(it.warranty_until ?? '');
        setUsageCount(String(it.usage_count));
        setNote(it.note || '');
        setSelectedTagIds(it.tags.map((t) => t.id));
      }
    }
  }, [open, isEdit, detail?.item, defaultCurrency]);

  const categoryOptions = useMemo(
    () => buildCategorySelectOptions(categories, '未分类', false),
    [categories],
  );

  const parentOptions = useMemo(
    () => [
      { value: '', label: '独立顶级物品（无父物品）' },
      ...allItems
        .filter((it) => it.id !== itemId)
        .map((p) => ({
          value: String(p.id),
          label: p.name,
          description: p.category_name || undefined,
        })),
    ],
    [allItems, itemId],
  );

  const channelOptions = useMemo(
    () => [
      { value: '', label: '未设置' },
      ...channels.map((ch) => ({ value: String(ch.id), label: ch.name })),
    ],
    [channels],
  );

  const locationOptions = useMemo(
    () => [
      { value: '', label: '未设置' },
      ...locations.map((loc) => ({ value: String(loc.id), label: loc.name })),
    ],
    [locations],
  );

  const statusOptions = useMemo(
    () => [
      { value: 'active', label: '服役中' },
      { value: 'favorite', label: '收藏' },
      ...(status === 'retired' ? [{ value: 'retired', label: '已退役' }] : []),
    ],
    [status],
  );

  const refreshDetail = () => {
    if (itemId) {
      void qc.invalidateQueries({ queryKey: ['assets', 'detail', itemId] });
    }
  };

  const saveMut = useMutation({
    mutationFn: () => {
      const payload: UpsertItemInput = {
        name: name.trim(),
        icon: icon.trim() || 'package',
        image_url: imageUrl.trim(),
        price: Number(price) || 0,
        currency,
        purchased_at: purchasedAt,
        pricing_mode: pricingMode,
        status: isEdit ? status : status === 'retired' ? 'active' : status,
        parent_id: parentId ? Number(parentId) : undefined,
        category_id: categoryId ? Number(categoryId) : undefined,
        channel_id: channelId ? Number(channelId) : undefined,
        location_id: locationId ? Number(locationId) : undefined,
        expected_retire_at: expectedRetireAt,
        warranty_until: warrantyUntil,
        usage_count: Math.max(0, parseInt(usageCount, 10) || 0),
        note: note.trim(),
        tag_ids: selectedTagIds,
      };
      return isEdit ? assetsApi.updateItem(itemId!, payload) : assetsApi.createItem(payload);
    },
    onSuccess: () => {
      setErrMsg('');
      onMutated(isEdit ? '物品已更新' : '物品已录入');
      if (isEdit) {
        refreshDetail();
      } else {
        onClose();
      }
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const deleteMut = useMutation({
    mutationFn: () => assetsApi.deleteItem(itemId!),
    onSuccess: () => {
      onMutated('物品已删除');
      onClose();
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const retireMut = useMutation({
    mutationFn: (payload: RetireItemInput) => assetsApi.retireItem(itemId!, payload),
    onSuccess: () => {
      setRetireOpen(false);
      refreshDetail();
      onMutated('已记录退役');
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const unretireMut = useMutation({
    mutationFn: () => assetsApi.unretireItem(itemId!),
    onSuccess: () => {
      refreshDetail();
      onMutated('已恢复服役');
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const addTxMut = useMutation({
    mutationFn: () =>
      assetsApi.createTransaction(itemId!, {
        type: txType,
        amount: Number(txAmount) || 0,
        currency: txCurrency,
        occurred_at: txDate,
        include_in_cost: txType === 'expense' ? txInclude : false,
        note: txNote.trim(),
      }),
    onSuccess: () => {
      setTxAmount('');
      setTxNote('');
      refreshDetail();
      onMutated('已添加收支明细');
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const delTxMut = useMutation({
    mutationFn: (txId: number) => assetsApi.deleteTransaction(itemId!, txId),
    onSuccess: () => {
      refreshDetail();
      onMutated('已删除收支明细');
    },
  });

  const quickChannelMut = useMutation({
    mutationFn: (n: string) => assetsApi.createChannel({ name: n }),
    onSuccess: (res) => {
      setNewChannelName('');
      setChannelId(String(res.channel.id));
      void qc.invalidateQueries({ queryKey: ['assets', 'meta'] });
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const quickLocationMut = useMutation({
    mutationFn: (n: string) => assetsApi.createLocation({ name: n }),
    onSuccess: (res) => {
      setNewLocationName('');
      setLocationId(String(res.location.id));
      void qc.invalidateQueries({ queryKey: ['assets', 'meta'] });
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const quickTagMut = useMutation({
    mutationFn: (n: string) => assetsApi.createTag({ name: n }),
    onSuccess: (res) => {
      setNewTagName('');
      setSelectedTagIds((cur) => [...cur, res.tag.id]);
      void qc.invalidateQueries({ queryKey: ['assets', 'meta'] });
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/15 p-4 backdrop-blur-[2px]"
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className={`flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-xl transition-all ${
            showMore || isEdit ? 'max-w-2xl' : 'max-w-lg'
          }`}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-100 px-6 py-4">
            <div className="flex min-w-0 items-center gap-2.5">
              {isEdit && (
                <AssetVisual icon={icon} imageUrl={imageUrl} name={name || '物品'} size="sm" />
              )}
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-zinc-900">
                  {isEdit ? detail?.item.name || '编辑物品' : '新建物品'}
                </h3>
                {isEdit && detail?.item && (
                  <p className="font-mono text-[11px] text-zinc-400">
                    投入 {formatMoney(detail.item.total_invested, defaultCurrency, hideAmounts)} ·
                    回收 {formatMoney(detail.item.total_recovered, defaultCurrency, hideAmounts)} ·
                    净支出 {formatMoney(detail.item.net_spent, defaultCurrency, hideAmounts)}
                  </p>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {isEdit && detail?.item && (
                <>
                  {detail.item.status === 'retired' ? (
                    <button
                      type="button"
                      onClick={() => unretireMut.mutate()}
                      disabled={unretireMut.isPending}
                      className="yd-btn-secondary text-xs"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      撤销退役
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRetireOpen(true)}
                      className="yd-btn-secondary text-xs"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      退役/卖出
                    </button>
                  )}
                  <Tooltip content="删除物品">
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('确认删除该物品吗？关联子物品会自动转为独立物品。')) {
                          deleteMut.mutate();
                        }
                      }}
                      className="yd-btn-danger-icon"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </Tooltip>
                </>
              )}
              <button type="button" onClick={onClose} className="yd-btn-icon">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-5 overflow-y-auto p-6">
            {isEdit && isLoading ? (
              <LoadingState label="正在加载模块..." variant="compact" />
            ) : (
              <>
                {errMsg && <div className="yd-notice-error">{errMsg}</div>}

                {/* Retired Banner */}
                {isEdit && detail?.item.status === 'retired' && (
                  <div className="yd-notice flex flex-wrap items-center gap-x-2 gap-y-1 bg-zinc-50 text-xs">
                    <span className="font-semibold text-zinc-700">已退役</span>
                    {detail.item.retired_at && <span>· {detail.item.retired_at}</span>}
                    {detail.item.retire_reason && (
                      <span>
                        · 原因：
                        {RETIRE_REASON_LABELS[detail.item.retire_reason as RetireReason] ||
                          detail.item.retire_reason}
                      </span>
                    )}
                    {detail.item.sold_price > 0 && (
                      <span className="font-mono text-emerald-600">
                        · 出售所得{' '}
                        {formatMoney(detail.item.sold_price, detail.item.sold_currency, hideAmounts)}
                      </span>
                    )}
                    {detail.item.retire_note && (
                      <span className="text-zinc-500">（{detail.item.retire_note}）</span>
                    )}
                  </div>
                )}

                <form
                  id="asset-item-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!name.trim()) {
                      setErrMsg('请输入物品名称');
                      return;
                    }
                    saveMut.mutate();
                  }}
                  className="space-y-4"
                >
                  {/* Essential Quick-Entry Fields (Always Visible) */}
                  <div className="space-y-3.5">
                    <label className="block space-y-1.5">
                      <span className="yd-label">物品名称 *</span>
                      <input
                        required
                        autoFocus={!isEdit}
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="例如：MacBook Pro、降噪耳机"
                        className="yd-input"
                      />
                    </label>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                      <label className="block space-y-1.5 sm:col-span-5">
                        <span className="yd-label">购入价格</span>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={price}
                          onChange={(e) => setPrice(e.target.value)}
                          placeholder="0.00"
                          className="yd-input font-mono"
                        />
                      </label>
                      <div className="space-y-1.5 sm:col-span-3">
                        <span className="yd-label block">币种</span>
                        <Select
                          value={currency}
                          onChange={(v) => setCurrency(v as Currency)}
                          options={CURRENCY_OPTIONS}
                          size="md"
                          searchable={false}
                          className="w-full"
                          ariaLabel="选择币种"
                        />
                      </div>
                      <div className="space-y-1.5 sm:col-span-4">
                        <span className="yd-label block">分类</span>
                        <Select
                          value={categoryId}
                          onChange={setCategoryId}
                          options={categoryOptions}
                          size="md"
                          className="w-full"
                          ariaLabel="选择分类"
                        />
                      </div>
                    </div>
                  </div>

                  {/* "更多选项" Toggle Button (Progressive Disclosure like Planner) */}
                  {!isEdit && (
                    <div className="border-t border-zinc-100 pt-3">
                      <button
                        type="button"
                        onClick={() => setShowMore((v) => !v)}
                        className="yd-btn-ghost px-1 text-sky-600 hover:bg-sky-50/70 hover:text-sky-700"
                      >
                        {showMore ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                        {showMore ? '收起更多选项' : '更多选项（日期、计价、图标、保修、渠道、子物品等）'}
                      </button>
                    </div>
                  )}

                  {/* Full Details Section */}
                  {(showMore || isEdit) && (
                    <div className="yd-panel-subtle space-y-4 p-4">
                      {/* Icon & Image URL */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <span className="yd-label block">默认图标</span>
                          <button
                            type="button"
                            onClick={() => setIconPickerOpen((v) => !v)}
                            className="yd-btn-secondary w-full justify-between py-2"
                          >
                            <span className="inline-flex min-w-0 items-center gap-2">
                              <AssetIcon name={icon} className="h-4 w-4 shrink-0 text-sky-600" />
                              <span className="truncate font-mono text-xs">{icon}</span>
                            </span>
                            <span className="shrink-0 text-xs text-zinc-400">
                              {iconPickerOpen ? '收起' : '更换'}
                            </span>
                          </button>
                        </div>

                        <label className="block space-y-1.5">
                          <span className="yd-label">图片 URL（可选）</span>
                          <input
                            type="url"
                            value={imageUrl}
                            onChange={(e) => setImageUrl(e.target.value)}
                            placeholder="https://..."
                            className="yd-input"
                          />
                        </label>

                        {iconPickerOpen && (
                          <div className="sm:col-span-2">
                            <IconPicker value={icon} onChange={setIcon} />
                          </div>
                        )}
                      </div>

                      {/* Purchase Date, Pricing Mode, Status, Usage Count */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="block space-y-1.5">
                          <span className="yd-label">购买日期</span>
                          <input
                            type="date"
                            value={purchasedAt}
                            onChange={(e) => setPurchasedAt(e.target.value)}
                            className="yd-input"
                          />
                        </label>

                        <div className="space-y-1.5">
                          <span className="yd-label block">计价方式</span>
                          <Select
                            value={pricingMode}
                            onChange={(v) => setPricingMode(v as PricingMode)}
                            options={PRICING_MODE_OPTIONS}
                            size="md"
                            searchable={false}
                            className="w-full"
                            ariaLabel="选择计价方式"
                          />
                        </div>

                        <div className="space-y-1.5">
                          <span className="yd-label block">使用状态</span>
                          <Select
                            value={status}
                            disabled={status === 'retired'}
                            onChange={(v) => setStatus(v as ItemStatus)}
                            options={statusOptions}
                            size="md"
                            searchable={false}
                            className="w-full"
                            ariaLabel="选择使用状态"
                          />
                        </div>

                        <div className="space-y-1.5">
                          <span className="yd-label block">使用次数</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setUsageCount(
                                  String(Math.max(0, (parseInt(usageCount, 10) || 0) - 1)),
                                )
                              }
                              className="yd-btn-secondary shrink-0 px-2.5 py-2"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <input
                              type="number"
                              min={0}
                              value={usageCount}
                              onChange={(e) => setUsageCount(e.target.value)}
                              className="yd-input min-w-0 flex-1 text-center font-mono"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setUsageCount(String((parseInt(usageCount, 10) || 0) + 1))
                              }
                              className="yd-btn-secondary shrink-0 px-2.5 py-2"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Warranty & Expected Retire */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="block space-y-1.5">
                          <span className="yd-label">保修 / 保质期到期日</span>
                          <input
                            type="date"
                            value={warrantyUntil}
                            onChange={(e) => setWarrantyUntil(e.target.value)}
                            className="yd-input"
                          />
                        </label>
                        <label className="block space-y-1.5">
                          <span className="yd-label">预计退役日期</span>
                          <input
                            type="date"
                            value={expectedRetireAt}
                            onChange={(e) => setExpectedRetireAt(e.target.value)}
                            className="yd-input"
                          />
                        </label>
                      </div>

                      {/* Parent Item Assignment (Option A) */}
                      <div className="space-y-1.5">
                        <span className="yd-label block">
                          归属父物品（可随时挂载为配件或解除归属）
                        </span>
                        <Select
                          value={parentId}
                          onChange={setParentId}
                          options={parentOptions}
                          size="md"
                          className="w-full"
                          ariaLabel="选择归属父物品"
                        />
                      </div>

                      {/* Channel & Location (Fixed flex min-w-0 + shrink-0, zero overlap) */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1.5">
                          <span className="yd-label block">购买渠道</span>
                          <Select
                            value={channelId}
                            onChange={setChannelId}
                            options={channelOptions}
                            size="md"
                            className="w-full"
                            ariaLabel="选择购买渠道"
                          />
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={newChannelName}
                              onChange={(e) => setNewChannelName(e.target.value)}
                              placeholder="新建渠道..."
                              className="yd-input-sm min-w-0 flex-1"
                            />
                            <button
                              type="button"
                              disabled={!newChannelName.trim() || quickChannelMut.isPending}
                              onClick={() => quickChannelMut.mutate(newChannelName.trim())}
                              className="yd-btn-secondary shrink-0 whitespace-nowrap"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              新建
                            </button>
                          </div>
                        </div>

                        <div className="min-w-0 space-y-1.5">
                          <span className="yd-label block">存放位置</span>
                          <Select
                            value={locationId}
                            onChange={setLocationId}
                            options={locationOptions}
                            size="md"
                            className="w-full"
                            ariaLabel="选择存放位置"
                          />
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={newLocationName}
                              onChange={(e) => setNewLocationName(e.target.value)}
                              placeholder="新建位置..."
                              className="yd-input-sm min-w-0 flex-1"
                            />
                            <button
                              type="button"
                              disabled={!newLocationName.trim() || quickLocationMut.isPending}
                              onClick={() => quickLocationMut.mutate(newLocationName.trim())}
                              className="yd-btn-secondary shrink-0 whitespace-nowrap"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              新建
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Tags */}
                      <div className="space-y-2">
                        <span className="yd-label block">标签</span>
                        {tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {tags.map((tag) => {
                              const active = selectedTagIds.includes(tag.id);
                              return (
                                <button
                                  key={tag.id}
                                  type="button"
                                  onClick={() =>
                                    setSelectedTagIds((cur) =>
                                      cur.includes(tag.id)
                                        ? cur.filter((x) => x !== tag.id)
                                        : [...cur, tag.id],
                                    )
                                  }
                                  className={`yd-badge transition-colors ${
                                    active
                                      ? 'bg-sky-500 text-white'
                                      : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:ring-sky-300'
                                  }`}
                                >
                                  {tag.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 sm:max-w-xs">
                          <input
                            type="text"
                            value={newTagName}
                            onChange={(e) => setNewTagName(e.target.value)}
                            placeholder="新建标签..."
                            className="yd-input-sm min-w-0 flex-1"
                          />
                          <button
                            type="button"
                            disabled={!newTagName.trim() || quickTagMut.isPending}
                            onClick={() => quickTagMut.mutate(newTagName.trim())}
                            className="yd-btn-secondary shrink-0 whitespace-nowrap"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            新建
                          </button>
                        </div>
                      </div>

                      {/* Note */}
                      <label className="block space-y-1.5">
                        <span className="yd-label">备注</span>
                        <textarea
                          rows={2}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="规格、序列号、保养记录等..."
                          className="yd-input resize-none"
                        />
                      </label>
                    </div>
                  )}
                </form>

                {/* Children Section (when editing existing item) */}
                {isEdit && detail && (
                  <div className="space-y-2.5 border-t border-zinc-100 pt-4">
                    <div className="flex items-center justify-between">
                      <h4 className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-zinc-800">
                        <Layers className="h-4 w-4 text-sky-500" />
                        关联子物品（{detail.children.length}）
                      </h4>
                      {detail.children.length > 0 && (
                        <span className="font-mono text-xs text-zinc-500">
                          含子物品总投入{' '}
                          <strong className="text-zinc-800">
                            {formatMoney(
                              detail.item.total_invested + detail.item.children_total_invested,
                              defaultCurrency,
                              hideAmounts,
                            )}
                          </strong>
                        </span>
                      )}
                    </div>

                    {detail.children.length === 0 ? (
                      <div className="rounded-lg bg-[#f8fafc] px-3 py-2.5 text-xs text-zinc-400">
                        暂无子物品。可在任意其他物品的「归属父物品」中选择本物品进行挂载。
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {detail.children.map((ch) => (
                          <button
                            key={ch.id}
                            type="button"
                            onClick={() => onSelectItem(ch.id)}
                            className="flex w-full items-center justify-between rounded-lg border border-zinc-200/75 bg-[#f8fafc] px-3 py-2 text-left transition-colors hover:border-sky-300 hover:bg-sky-50/40"
                          >
                            <div className="flex min-w-0 items-center gap-2.5">
                              <AssetVisual
                                icon={ch.icon}
                                imageUrl={ch.image_url}
                                name={ch.name}
                                size="sm"
                              />
                              <span className="truncate text-sm font-medium text-zinc-700">
                                {ch.name}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 font-mono text-xs text-zinc-600">
                              <span>
                                {formatMoney(ch.total_invested, ch.display_currency, hideAmounts)}
                              </span>
                              <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Extra Transactions Section */}
                {isEdit && detail && (
                  <div className="space-y-3 border-t border-zinc-100 pt-4">
                    <h4 className="text-[13px] font-semibold text-zinc-800">
                      附加收支明细（{detail.transactions.length}）
                    </h4>

                    <div className="yd-panel-subtle space-y-2.5 p-3">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <Select
                          value={txType}
                          onChange={(v) => setTxType(v as 'expense' | 'income')}
                          options={TX_TYPE_OPTIONS}
                          searchable={false}
                          className="w-full"
                          ariaLabel="选择收支类型"
                        />
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={txAmount}
                          onChange={(e) => setTxAmount(e.target.value)}
                          placeholder="金额"
                          className="yd-input-sm min-w-0 font-mono"
                        />
                        <Select
                          value={txCurrency}
                          onChange={(v) => setTxCurrency(v as Currency)}
                          options={CURRENCY_OPTIONS}
                          searchable={false}
                          className="w-full"
                          ariaLabel="选择收支币种"
                        />
                        <input
                          type="date"
                          value={txDate}
                          onChange={(e) => setTxDate(e.target.value)}
                          className="yd-input-sm min-w-0"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={txNote}
                          onChange={(e) => setTxNote(e.target.value)}
                          placeholder="备注（例如：维修费、贴膜、出租收入）"
                          className="yd-input-sm min-w-0 flex-1"
                        />
                        {txType === 'expense' && (
                          <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-zinc-600">
                            <input
                              type="checkbox"
                              checked={txInclude}
                              onChange={(e) => setTxInclude(e.target.checked)}
                            />
                            计入成本
                          </label>
                        )}
                        <button
                          type="button"
                          disabled={!txAmount || Number(txAmount) <= 0 || addTxMut.isPending}
                          onClick={() => addTxMut.mutate()}
                          className="yd-btn-primary shrink-0 py-1.5"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          添加
                        </button>
                      </div>
                    </div>

                    {detail.transactions.length > 0 && (
                      <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/75 bg-white">
                        {detail.transactions.map((tx) => (
                          <div
                            key={tx.id}
                            className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={`yd-badge ${
                                    tx.type === 'expense' ? 'yd-badge-red' : 'yd-badge-emerald'
                                  }`}
                                >
                                  {tx.type === 'expense' ? '支出' : '收入'}
                                </span>
                                {tx.type === 'expense' && !tx.include_in_cost && (
                                  <span className="yd-badge yd-badge-neutral">不计入成本</span>
                                )}
                                <span className="font-mono text-zinc-400">{tx.occurred_at}</span>
                              </div>
                              {tx.note && <div className="mt-0.5 text-zinc-600">{tx.note}</div>}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <div className="text-right font-mono">
                                <div
                                  className={
                                    tx.type === 'expense'
                                      ? 'font-medium text-zinc-800'
                                      : 'font-medium text-emerald-600'
                                  }
                                >
                                  {tx.type === 'expense' ? '+' : '-'}
                                  {formatMoney(tx.converted_amount, defaultCurrency, hideAmounts)}
                                </div>
                                {tx.currency !== defaultCurrency && (
                                  <div className="text-[11px] text-zinc-400">
                                    {formatMoney(tx.amount, tx.currency, hideAmounts)}
                                  </div>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => delTxMut.mutate(tx.id)}
                                className="yd-btn-danger-icon"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-100 bg-zinc-50/50 px-6 py-3.5">
            <button type="button" onClick={onClose} className="yd-btn-secondary">
              取消
            </button>
            <button
              type="submit"
              form="asset-item-form"
              disabled={saveMut.isPending}
              className="yd-btn-primary"
            >
              {saveMut.isPending ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>

      <RetireModal
        open={retireOpen}
        title={`办理退役：${detail?.item.name ?? ''}`}
        defaultCurrency={defaultCurrency}
        submitting={retireMut.isPending}
        onClose={() => setRetireOpen(false)}
        onSubmit={(payload) => retireMut.mutate(payload)}
      />
    </>
  );
}

// ============================================================================
// 3. MetaManagerModal (2-Level Categories, Tags, Channels, Locations)
// ============================================================================

type MetaTab = 'categories' | 'tags' | 'channels' | 'locations';

export function MetaManagerModal({
  open,
  categories,
  tags,
  channels,
  locations,
  onClose,
  onChanged,
}: {
  open: boolean;
  categories: AssetCategory[];
  tags: AssetTag[];
  channels: AssetChannel[];
  locations: AssetLocation[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<MetaTab>('categories');
  const [errMsg, setErrMsg] = useState('');

  // Category state
  const [catName, setCatName] = useState('');
  const [catIcon, setCatIcon] = useState('folder');
  const [catParentId, setCatParentId] = useState<string>('');
  const [editingCat, setEditingCat] = useState<AssetCategory | null>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);

  // Simple entity inputs
  const [tagName, setTagName] = useState('');
  const [tagColor, setTagColor] = useState('#0ea5e9');
  const [channelName, setChannelName] = useState('');
  const [locationName, setLocationName] = useState('');

  useEffect(() => {
    if (open) {
      setErrMsg('');
      setEditingCat(null);
      setCatName('');
      setCatIcon('folder');
      setCatParentId('');
      setShowIconPicker(false);
    }
  }, [open]);

  const saveCatMut = useMutation({
    mutationFn: () => {
      const payload = {
        name: catName.trim(),
        icon: catIcon || 'folder',
        parent_id: catParentId ? Number(catParentId) : undefined,
      };
      return editingCat
        ? assetsApi.updateCategory(editingCat.id, payload)
        : assetsApi.createCategory(payload);
    },
    onSuccess: () => {
      setErrMsg('');
      setEditingCat(null);
      setCatName('');
      setCatIcon('folder');
      setCatParentId('');
      setShowIconPicker(false);
      onChanged();
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const delCatMut = useMutation({
    mutationFn: (id: number) => assetsApi.deleteCategory(id),
    onSuccess: () => {
      setErrMsg('');
      onChanged();
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const addTagMut = useMutation({
    mutationFn: () => assetsApi.createTag({ name: tagName.trim(), color: tagColor }),
    onSuccess: () => {
      setTagName('');
      setErrMsg('');
      onChanged();
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const delTagMut = useMutation({
    mutationFn: (id: number) => assetsApi.deleteTag(id),
    onSuccess: onChanged,
  });

  const addChannelMut = useMutation({
    mutationFn: () => assetsApi.createChannel({ name: channelName.trim() }),
    onSuccess: () => {
      setChannelName('');
      setErrMsg('');
      onChanged();
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const delChannelMut = useMutation({
    mutationFn: (id: number) => assetsApi.deleteChannel(id),
    onSuccess: onChanged,
  });

  const addLocationMut = useMutation({
    mutationFn: () => assetsApi.createLocation({ name: locationName.trim() }),
    onSuccess: () => {
      setLocationName('');
      setErrMsg('');
      onChanged();
    },
    onError: (err: Error) => setErrMsg(err.message),
  });

  const delLocationMut = useMutation({
    mutationFn: (id: number) => assetsApi.deleteLocation(id),
    onSuccess: onChanged,
  });

  if (!open) return null;

  const topCats = categories.filter((c) => !c.parent_id);
  const subsByParent = new Map<number, AssetCategory[]>();
  for (const c of categories) {
    if (c.parent_id) {
      const list = subsByParent.get(c.parent_id) ?? [];
      list.push(c);
      subsByParent.set(c.parent_id, list);
    }
  }

  const parentCategoryOptions = [
    { value: '', label: '作为一级分类' },
    ...topCats
      .filter((c) => !editingCat || c.id !== editingCat.id)
      .map((c) => ({ value: String(c.id), label: `归属：${c.name}` })),
  ];

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/15 p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
          <h3 className="text-sm font-semibold text-zinc-900">分类与属性管理</h3>
          <button type="button" onClick={onClose} className="yd-btn-icon">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="yd-tabs px-6">
          {(
            [
              ['categories', `两级分类 (${categories.length})`],
              ['tags', `标签 (${tags.length})`],
              ['channels', `购买渠道 (${channels.length})`],
              ['locations', `存放位置 (${locations.length})`],
            ] as [MetaTab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setTab(k);
                setErrMsg('');
              }}
              className={`yd-tab ${tab === k ? 'yd-tab-active' : 'yd-tab-idle'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {errMsg && <div className="yd-notice-error">{errMsg}</div>}

          {/* Categories Tab */}
          {tab === 'categories' && (
            <div className="space-y-4">
              <div className="yd-panel-subtle space-y-2.5 p-3.5">
                <div className="text-xs font-medium text-zinc-600">
                  {editingCat ? `编辑分类：${editingCat.name}` : '新增分类（最多两级）'}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input
                    type="text"
                    value={catName}
                    onChange={(e) => setCatName(e.target.value)}
                    placeholder="分类名称"
                    className="yd-input-sm min-w-0"
                  />
                  <Select
                    value={catParentId}
                    onChange={setCatParentId}
                    options={parentCategoryOptions}
                    searchable={false}
                    className="w-full"
                    ariaLabel="选择父级分类"
                  />
                  <button
                    type="button"
                    onClick={() => setShowIconPicker((v) => !v)}
                    className="yd-btn-secondary justify-between text-xs"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <AssetIcon name={catIcon} className="h-3.5 w-3.5 shrink-0 text-sky-600" />
                      <span className="truncate">{catIcon}</span>
                    </span>
                    <span className="shrink-0 text-zinc-400">图标</span>
                  </button>
                </div>
                {showIconPicker && <IconPicker value={catIcon} onChange={setCatIcon} />}
                <div className="flex justify-end gap-2">
                  {editingCat && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingCat(null);
                        setCatName('');
                        setCatIcon('folder');
                        setCatParentId('');
                      }}
                      className="yd-btn-secondary"
                    >
                      取消编辑
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!catName.trim() || saveCatMut.isPending}
                    onClick={() => saveCatMut.mutate()}
                    className="yd-btn-primary py-1.5"
                  >
                    {editingCat ? '保存修改' : '添加分类'}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {topCats.map((cat) => {
                  const subs = subsByParent.get(cat.id) ?? [];
                  return (
                    <div key={cat.id} className="rounded-xl border border-zinc-200/75 bg-white">
                      <div className="flex items-center justify-between px-3 py-2">
                        <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                          <AssetIcon name={cat.icon} className="h-4 w-4 text-sky-600" />
                          <span>{cat.name}</span>
                          <span className="text-xs text-zinc-400">({subs.length} 子类)</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCat(cat);
                              setCatName(cat.name);
                              setCatIcon(cat.icon);
                              setCatParentId('');
                            }}
                            className="yd-btn-icon"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `删除「${cat.name}」会同时移除其下二级分类，关联物品自动归入未分类，确认删除？`,
                                )
                              ) {
                                delCatMut.mutate(cat.id);
                              }
                            }}
                            className="yd-btn-danger-icon"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      {subs.length > 0 && (
                        <div className="divide-y divide-zinc-100 border-t border-zinc-100 bg-[#fafcff] pl-6">
                          {subs.map((sc) => (
                            <div
                              key={sc.id}
                              className="flex items-center justify-between px-3 py-1.5 text-xs"
                            >
                              <div className="flex items-center gap-2 text-zinc-700">
                                <AssetIcon name={sc.icon} className="h-3.5 w-3.5 text-zinc-400" />
                                <span>{sc.name}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingCat(sc);
                                    setCatName(sc.name);
                                    setCatIcon(sc.icon);
                                    setCatParentId(String(sc.parent_id ?? ''));
                                  }}
                                  className="yd-btn-icon"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => delCatMut.mutate(sc.id)}
                                  className="yd-btn-danger-icon"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {topCats.length === 0 && (
                  <div className="yd-empty py-8 text-xs">暂无分类，请在上方创建</div>
                )}
              </div>
            </div>
          )}

          {/* Tags Tab */}
          {tab === 'tags' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={tagName}
                  onChange={(e) => setTagName(e.target.value)}
                  placeholder="标签名（如：主力、出差、高频）"
                  className="yd-input-sm min-w-0 flex-1"
                />
                <input
                  type="color"
                  value={tagColor}
                  onChange={(e) => setTagColor(e.target.value)}
                  className="h-8 w-10 shrink-0 cursor-pointer rounded-lg border border-zinc-200 bg-white p-0.5"
                />
                <button
                  type="button"
                  disabled={!tagName.trim() || addTagMut.isPending}
                  onClick={() => addTagMut.mutate()}
                  className="yd-btn-primary shrink-0 py-1.5"
                >
                  添加
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-700"
                  >
                    {t.color && (
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                    )}
                    {t.name}
                    <button
                      type="button"
                      onClick={() => delTagMut.mutate(t.id)}
                      className="text-zinc-400 hover:text-red-500"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {tags.length === 0 && <div className="text-xs text-zinc-400">暂无标签</div>}
              </div>
            </div>
          )}

          {/* Channels Tab */}
          {tab === 'channels' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  placeholder="渠道名（如：京东、Apple 官网、海淘）"
                  className="yd-input-sm min-w-0 flex-1"
                />
                <button
                  type="button"
                  disabled={!channelName.trim() || addChannelMut.isPending}
                  onClick={() => addChannelMut.mutate()}
                  className="yd-btn-primary shrink-0 py-1.5"
                >
                  添加
                </button>
              </div>
              <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/75">
                {channels.map((ch) => (
                  <div
                    key={ch.id}
                    className="flex items-center justify-between px-3 py-2 text-sm text-zinc-700"
                  >
                    <span>{ch.name}</span>
                    <button
                      type="button"
                      onClick={() => delChannelMut.mutate(ch.id)}
                      className="yd-btn-danger-icon"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {channels.length === 0 && (
                  <div className="py-6 text-center text-xs text-zinc-400">暂无购买渠道</div>
                )}
              </div>
            </div>
          )}

          {/* Locations Tab */}
          {tab === 'locations' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                  placeholder="位置名（如：书桌、卧室衣柜、公司工位）"
                  className="yd-input-sm min-w-0 flex-1"
                />
                <button
                  type="button"
                  disabled={!locationName.trim() || addLocationMut.isPending}
                  onClick={() => addLocationMut.mutate()}
                  className="yd-btn-primary shrink-0 py-1.5"
                >
                  添加
                </button>
              </div>
              <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/75">
                {locations.map((loc) => (
                  <div
                    key={loc.id}
                    className="flex items-center justify-between px-3 py-2 text-sm text-zinc-700"
                  >
                    <span>{loc.name}</span>
                    <button
                      type="button"
                      onClick={() => delLocationMut.mutate(loc.id)}
                      className="yd-btn-danger-icon"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {locations.length === 0 && (
                  <div className="py-6 text-center text-xs text-zinc-400">暂无存放位置</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
