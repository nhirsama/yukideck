import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Pencil, Plus, Trash2, X } from 'lucide-react';
import { aiUsageApi, type Device, type ModelAlias, type ModelPrice } from './api';
import { formatDateTime } from './format';

export default function AIUsageSettingsPanel() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState('');

  const { data: devicesRes, isLoading: loadingDevices } = useQuery({
    queryKey: ['ai-usage', 'devices'],
    queryFn: aiUsageApi.listDevices,
  });
  const { data: aliasesRes, isLoading: loadingAliases } = useQuery({
    queryKey: ['ai-usage', 'aliases'],
    queryFn: aiUsageApi.listAliases,
  });
  const { data: pricesRes, isLoading: loadingPrices } = useQuery({
    queryKey: ['ai-usage', 'prices'],
    queryFn: aiUsageApi.listPrices,
  });

  // Device inline rename state
  const [editingDevice, setEditingDevice] = useState<{ id: string; value: string } | null>(null);
  const cancelEditRef = useRef(false);

  // Alias modal state
  const [aliasModalOpen, setAliasModalOpen] = useState(false);
  const [aliasEditing, setAliasEditing] = useState(false);
  const [aliasPattern, setAliasPattern] = useState('');
  const [aliasCanonical, setAliasCanonical] = useState('');
  const [aliasPriority, setAliasPriority] = useState(100);

  // Price modal state
  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [priceEditing, setPriceEditing] = useState(false);
  const [pricePattern, setPricePattern] = useState('');
  const [inputPerM, setInputPerM] = useState('3.0');
  const [outputPerM, setOutputPerM] = useState('15.0');
  const [cacheReadPerM, setCacheReadPerM] = useState('0.3');
  const [cacheWritePerM, setCacheWritePerM] = useState('3.75');
  const [cacheWrite1hPerM, setCacheWrite1hPerM] = useState('6.0');
  const [showBuiltinPrices, setShowBuiltinPrices] = useState(false);

  useEffect(() => {
    if (!aliasModalOpen && !priceModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAliasModalOpen(false);
        setPriceModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [aliasModalOpen, priceModalOpen]);

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['ai-usage'] });
  };

  const openAliasModal = (existing?: ModelAlias) => {
    if (existing) {
      setAliasEditing(true);
      setAliasPattern(existing.match_pattern);
      setAliasCanonical(existing.canonical_model);
      setAliasPriority(existing.priority);
    } else {
      setAliasEditing(false);
      setAliasPattern('');
      setAliasCanonical('');
      setAliasPriority(100);
    }
    setAliasModalOpen(true);
  };

  const openPriceModal = (existing?: ModelPrice, isEdit = false) => {
    if (existing) {
      setPriceEditing(isEdit);
      setPricePattern(existing.model_pattern);
      setInputPerM(String(existing.input_per_m));
      setOutputPerM(String(existing.output_per_m));
      setCacheReadPerM(String(existing.cache_read_per_m));
      setCacheWritePerM(String(existing.cache_write_per_m));
      setCacheWrite1hPerM(String(existing.cache_write_1h_per_m));
    } else {
      setPriceEditing(false);
      setPricePattern('');
      setInputPerM('3.0');
      setOutputPerM('15.0');
      setCacheReadPerM('0.3');
      setCacheWritePerM('3.75');
      setCacheWrite1hPerM('6.0');
    }
    setPriceModalOpen(true);
  };

  const updateDevMut = useMutation({
    mutationFn: ({ deviceId, name, hidden }: { deviceId: string; name: string; hidden: boolean }) =>
      aiUsageApi.updateDevice(deviceId, { name, hidden }),
    onSuccess: () => {
      setNotice('设备信息已更新');
      invalidateAll();
    },
    onError: (err: Error) => setNotice(`更新失败：${err.message}`),
  });

  const deleteDevMut = useMutation({
    mutationFn: (deviceId: string) => aiUsageApi.deleteDevice(deviceId),
    onSuccess: () => {
      setNotice('设备记录已删除');
      invalidateAll();
    },
    onError: (err: Error) => setNotice(`删除失败：${err.message}`),
  });

  const saveAliasMut = useMutation({
    mutationFn: aiUsageApi.upsertAlias,
    onSuccess: () => {
      setAliasModalOpen(false);
      setAliasPattern('');
      setAliasCanonical('');
      setAliasPriority(100);
      setNotice('模型别名规则已保存');
      invalidateAll();
    },
    onError: (err: Error) => setNotice(`保存别名失败：${err.message}`),
  });

  const deleteAliasMut = useMutation({
    mutationFn: aiUsageApi.deleteAlias,
    onSuccess: () => {
      setNotice('模型别名已删除');
      invalidateAll();
    },
    onError: (err: Error) => setNotice(`删除别名失败：${err.message}`),
  });

  const savePriceMut = useMutation({
    mutationFn: aiUsageApi.upsertPrice,
    onSuccess: () => {
      setPriceModalOpen(false);
      setPricePattern('');
      setNotice('自定义单价已保存');
      invalidateAll();
    },
    onError: (err: Error) => setNotice(`保存单价失败：${err.message}`),
  });

  const deletePriceMut = useMutation({
    mutationFn: aiUsageApi.deletePrice,
    onSuccess: () => {
      setNotice('自定义单价已删除');
      invalidateAll();
    },
    onError: (err: Error) => setNotice(`删除单价失败：${err.message}`),
  });

  const devices = devicesRes?.devices ?? [];
  const aliases = aliasesRes?.aliases ?? [];
  const customPrices = pricesRes?.custom ?? [];
  const builtinPrices = pricesRes?.builtin ?? [];

  const commitDeviceRename = (d: Device) => {
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      setEditingDevice(null);
      return;
    }
    const nextName = (editingDevice?.id === d.device_id ? editingDevice.value : d.name).trim();
    setEditingDevice(null);
    if (!nextName || nextName === d.name) return;
    updateDevMut.mutate({ deviceId: d.device_id, name: nextName, hidden: d.hidden });
  };

  const toggleDeviceHidden = (d: Device) => {
    updateDevMut.mutate({ deviceId: d.device_id, name: d.name, hidden: !d.hidden });
  };

  const handleAliasSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setNotice('');
    saveAliasMut.mutate({
      match_pattern: aliasPattern.trim(),
      canonical_model: aliasCanonical.trim(),
      priority: Number(aliasPriority) || 100,
    });
  };

  const handlePriceSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setNotice('');
    savePriceMut.mutate({
      model_pattern: pricePattern.trim(),
      input_per_m: Number(inputPerM) || 0,
      output_per_m: Number(outputPerM) || 0,
      cache_read_per_m: Number(cacheReadPerM) || 0,
      cache_write_per_m: Number(cacheWritePerM) || 0,
      cache_write_1h_per_m: Number(cacheWrite1hPerM) || 0,
    });
  };

  const serverOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://deck.example.com';

  return (
    <div className="space-y-6">
      {notice && <div className="yd-notice">{notice}</div>}

      {/* 1. Devices */}
      <section className="yd-card p-6 space-y-4">
        <div>
          <h2 className="text-[15px] font-semibold text-zinc-800">设备与探针</h2>
          <p className="text-[13px] text-zinc-500 mt-0.5">
            探针上报时自动注册；隐藏后不计入默认看板，历史数据保留。
          </p>
        </div>
        {loadingDevices ? (
          <div className="text-sm text-zinc-400">加载中...</div>
        ) : devices.length === 0 ? (
          <div className="text-sm text-zinc-400">暂无已上报设备。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="yd-table">
              <thead className="yd-thead">
                <tr>
                  <th className="py-2 pr-3 font-medium">设备名称</th>
                  <th className="py-2 pr-3 font-medium">Device ID</th>
                  <th className="py-2 pr-3 font-medium">系统 / 架构</th>
                  <th className="py-2 pr-3 font-medium">探针版本</th>
                  <th className="py-2 pr-3 font-medium">最近同步</th>
                  <th className="py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="yd-tbody tabular-nums">
                {devices.map((d) => {
                  const isEditing = editingDevice?.id === d.device_id;
                  return (
                    <tr key={d.device_id} className={`group ${d.hidden ? 'opacity-50' : ''}`}>
                      <td className="py-2.5 pr-3">
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editingDevice.value}
                            onChange={(e) =>
                              setEditingDevice({ id: d.device_id, value: e.target.value })
                            }
                            onBlur={() => commitDeviceRename(d)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                cancelEditRef.current = true;
                                setEditingDevice(null);
                              }
                            }}
                            className="yd-input-sm w-44"
                          />
                        ) : (
                          <div className="inline-flex items-center gap-1 max-w-[210px]">
                            <span className="font-medium text-zinc-800 truncate">{d.name}</span>
                            <button
                              type="button"
                              title="重命名设备"
                              onClick={() => {
                                cancelEditRef.current = false;
                                setEditingDevice({ id: d.device_id, value: d.name });
                              }}
                              className="yd-btn-icon p-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-zinc-600">{d.device_id}</td>
                      <td className="py-2.5 pr-3 text-zinc-600">
                        {[d.os, d.arch].filter(Boolean).join('/') || '-'}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-zinc-600">{d.collector_version || '-'}</td>
                      <td className="py-2.5 pr-3 text-zinc-500">{formatDateTime(d.last_synced_at)}</td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => toggleDeviceHidden(d)}
                            className="yd-btn-secondary py-1"
                            title={d.hidden ? '取消隐藏' : '隐藏设备'}
                          >
                            {d.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                            {d.hidden ? '显示' : '隐藏'}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteDevMut.mutate(d.device_id)}
                            className="yd-btn-danger-icon"
                            title="删除设备元信息"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 2. Model Aliases */}
      <section className="yd-card p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[15px] font-semibold text-zinc-800">模型别名规则</h2>
            <p className="text-[13px] text-zinc-500 mt-0.5">
              支持 <code className="yd-code">*</code> 通配符，优先精确匹配再通配（同级内 priority 越小越优先）；多级{' '}
              <code className="yd-code">/</code> 渠道前缀自动剥离。
            </p>
          </div>
          <button
            type="button"
            onClick={() => openAliasModal()}
            className="yd-btn-primary py-1.5"
          >
            <Plus className="h-4 w-4" />
            添加规则
          </button>
        </div>

        {loadingAliases ? (
          <div className="text-sm text-zinc-400">加载中...</div>
        ) : aliases.length === 0 ? (
          <div className="text-sm text-zinc-400">
            暂无自定义别名规则（当前使用内置渠道前缀与日期后缀清洗）。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="yd-table">
              <thead className="yd-thead">
                <tr>
                  <th className="py-2 pr-3 font-medium">匹配模式</th>
                  <th className="py-2 pr-3 font-medium">标准模型名</th>
                  <th className="py-2 pr-3 font-medium">优先级</th>
                  <th className="py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="yd-tbody tabular-nums">
                {aliases.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2.5 pr-3 font-mono text-zinc-800">{a.match_pattern}</td>
                    <td className="py-2.5 pr-3 font-mono text-zinc-800">{a.canonical_model}</td>
                    <td className="py-2.5 pr-3 text-zinc-600">{a.priority}</td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          title="编辑"
                          onClick={() => openAliasModal(a)}
                          className="yd-btn-icon"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="删除"
                          onClick={() => deleteAliasMut.mutate(a.id)}
                          className="yd-btn-danger-icon"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Model Prices */}
      <section className="yd-card p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[15px] font-semibold text-zinc-800">模型单价（USD / 1M Tokens）</h2>
            <p className="text-[13px] text-zinc-500 mt-0.5">
              优先精确匹配再通配（用户精确 → 内置精确 → 用户通配 → 内置通配）；原始模型存在精确单价时优先按原始模型计价，保存后即时重算历史费用。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowBuiltinPrices((v) => !v)}
              className="yd-btn-secondary"
            >
              {showBuiltinPrices ? '收起内置单价' : `查看内置单价 (${builtinPrices.length})`}
            </button>
            <button
              type="button"
              onClick={() => openPriceModal()}
              className="yd-btn-primary py-1.5"
            >
              <Plus className="h-4 w-4" />
              添加单价
            </button>
          </div>
        </div>

        {loadingPrices ? (
          <div className="text-sm text-zinc-400">加载中...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="yd-table">
              <thead className="yd-thead">
                <tr>
                  <th className="py-2 pr-3 font-medium">模型模式</th>
                  <th className="py-2 pr-3 font-medium">Input</th>
                  <th className="py-2 pr-3 font-medium">Output</th>
                  <th className="py-2 pr-3 font-medium">Cache Read</th>
                  <th className="py-2 pr-3 font-medium">Cache Write</th>
                  <th className="py-2 pr-3 font-medium">Cache Write 1h</th>
                  <th className="py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="yd-tbody tabular-nums">
                {customPrices.map((p) => (
                  <tr key={`custom-${p.id}`}>
                    <td className="py-2.5 pr-3 font-mono text-zinc-900">{p.model_pattern}</td>
                    <td className="py-2.5 pr-3 text-zinc-700">${p.input_per_m}</td>
                    <td className="py-2.5 pr-3 text-zinc-700">${p.output_per_m}</td>
                    <td className="py-2.5 pr-3 text-zinc-700">${p.cache_read_per_m}</td>
                    <td className="py-2.5 pr-3 text-zinc-700">${p.cache_write_per_m}</td>
                    <td className="py-2.5 pr-3 text-zinc-700">${p.cache_write_1h_per_m}</td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          title="编辑"
                          onClick={() => openPriceModal(p, true)}
                          className="yd-btn-icon"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="删除"
                          onClick={() => p.id && deletePriceMut.mutate(p.id)}
                          className="yd-btn-danger-icon"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {customPrices.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-4 text-zinc-400">
                      暂无自定义覆盖单价。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {showBuiltinPrices && (
          <div className="pt-4 border-t border-zinc-100 overflow-x-auto">
            <div className="text-xs font-medium text-zinc-500 mb-2">内置默认单价参考</div>
            <table className="yd-table text-zinc-600">
              <thead className="yd-thead">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">模型模式</th>
                  <th className="py-1.5 pr-3 font-medium">Input</th>
                  <th className="py-1.5 pr-3 font-medium">Output</th>
                  <th className="py-1.5 pr-3 font-medium">Cache Read</th>
                  <th className="py-1.5 pr-3 font-medium">Cache Write</th>
                  <th className="py-1.5 pr-3 font-medium">Cache Write 1h</th>
                  <th className="py-1.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="yd-tbody tabular-nums">
                {builtinPrices.map((p) => (
                  <tr key={`builtin-${p.model_pattern}`}>
                    <td className="py-1.5 pr-3 font-mono">{p.model_pattern}</td>
                    <td className="py-1.5 pr-3">${p.input_per_m}</td>
                    <td className="py-1.5 pr-3">${p.output_per_m}</td>
                    <td className="py-1.5 pr-3">${p.cache_read_per_m}</td>
                    <td className="py-1.5 pr-3">${p.cache_write_per_m}</td>
                    <td className="py-1.5 pr-3">${p.cache_write_1h_per_m}</td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => openPriceModal(p, false)}
                        className="text-[11px] font-medium text-sky-600 hover:text-sky-700"
                      >
                        覆盖
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. Collector quick reference */}
      <section className="yd-card p-6 space-y-2.5 text-[13px] text-zinc-500">
        <h2 className="text-[15px] font-semibold text-zinc-800">探针接入</h2>
        <p>
          先在 API Keys 签发 <code className="yd-code">ai-usage:ingest</code> 密钥，然后在开发机执行：
        </p>
        <pre className="rounded-lg border border-zinc-200/80 bg-[#f4f7fa] px-4 py-3 text-zinc-700 overflow-x-auto font-mono text-xs leading-relaxed">
{`yukideck-collector init --server ${serverOrigin} --api-key ydk_xxx --device-name my-laptop
yukideck-collector doctor
yukideck-collector sync --all`}
        </pre>
      </section>

      {/* Alias Config Modal */}
      {aliasModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/20 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => setAliasModalOpen(false)}
        >
          <form
            onSubmit={handleAliasSubmit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-zinc-200/80 bg-white shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
              <h3 className="text-sm font-semibold text-zinc-900">
                {aliasEditing ? '编辑模型别名规则' : '添加模型别名规则'}
              </h3>
              <button
                type="button"
                onClick={() => setAliasModalOpen(false)}
                className="yd-btn-icon"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <label className="block space-y-1.5">
                <span className="yd-label">匹配模式</span>
                <input
                  required
                  autoFocus
                  placeholder="如 gpt-6.1-sol* 或 my-relay/sonnet-4"
                  value={aliasPattern}
                  onChange={(e) => setAliasPattern(e.target.value)}
                  className="yd-input font-mono"
                />
                <p className="text-[11px] text-zinc-400">
                  不含 <code className="yd-code">*</code> 的精确规则始终优先于通配规则。
                </p>
              </label>

              <label className="block space-y-1.5">
                <span className="yd-label">标准模型名</span>
                <input
                  required
                  placeholder="如 gpt-6.1-sol"
                  value={aliasCanonical}
                  onChange={(e) => setAliasCanonical(e.target.value)}
                  className="yd-input font-mono"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="yd-label">优先级</span>
                <input
                  type="number"
                  value={aliasPriority}
                  onChange={(e) => setAliasPriority(Number(e.target.value))}
                  className="yd-input tabular-nums"
                />
                <p className="text-[11px] text-zinc-400">
                  同级别（精确或通配）内数字越小越优先，默认 100。
                </p>
              </label>
            </div>

            <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-zinc-100 bg-zinc-50/50">
              <button
                type="button"
                onClick={() => setAliasModalOpen(false)}
                className="yd-btn-secondary"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saveAliasMut.isPending}
                className="yd-btn-primary"
              >
                {saveAliasMut.isPending ? '保存中...' : '保存规则'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Price Config Modal */}
      {priceModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/20 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => setPriceModalOpen(false)}
        >
          <form
            onSubmit={handlePriceSubmit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl border border-zinc-200/80 bg-white shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
              <h3 className="text-sm font-semibold text-zinc-900">
                {priceEditing ? '编辑模型单价' : '添加模型单价'}
              </h3>
              <button
                type="button"
                onClick={() => setPriceModalOpen(false)}
                className="yd-btn-icon"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <label className="block space-y-1.5">
                <span className="yd-label">模型模式</span>
                <input
                  required
                  autoFocus
                  placeholder="如 gpt-6.1-sol-fast 或 claude-sonnet-4.6*"
                  value={pricePattern}
                  onChange={(e) => setPricePattern(e.target.value)}
                  className="yd-input font-mono"
                />
                <p className="text-[11px] text-zinc-400">
                  精确模型名优先于内置单价与通配规则，单位为 USD / 1M Tokens。
                </p>
              </label>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <label className="block space-y-1.5">
                  <span className="yd-label">Input</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={inputPerM}
                    onChange={(e) => setInputPerM(e.target.value)}
                    className="yd-input-sm w-full tabular-nums"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="yd-label">Output</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={outputPerM}
                    onChange={(e) => setOutputPerM(e.target.value)}
                    className="yd-input-sm w-full tabular-nums"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="yd-label">Cache Read</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={cacheReadPerM}
                    onChange={(e) => setCacheReadPerM(e.target.value)}
                    className="yd-input-sm w-full tabular-nums"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="yd-label">Cache Write (5m)</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={cacheWritePerM}
                    onChange={(e) => setCacheWritePerM(e.target.value)}
                    className="yd-input-sm w-full tabular-nums"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="yd-label">Cache Write (1h)</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={cacheWrite1hPerM}
                    onChange={(e) => setCacheWrite1hPerM(e.target.value)}
                    className="yd-input-sm w-full tabular-nums"
                  />
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-zinc-100 bg-zinc-50/50">
              <button
                type="button"
                onClick={() => setPriceModalOpen(false)}
                className="yd-btn-secondary"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={savePriceMut.isPending}
                className="yd-btn-primary"
              >
                {savePriceMut.isPending ? '保存中...' : '保存单价'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
