import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { aiUsageApi, type Device } from './api';
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
  const [editingDeviceNames, setEditingDeviceNames] = useState<Record<string, string>>({});

  // Alias form state
  const [aliasPattern, setAliasPattern] = useState('');
  const [aliasCanonical, setAliasCanonical] = useState('');
  const [aliasPriority, setAliasPriority] = useState(100);

  // Price form state
  const [pricePattern, setPricePattern] = useState('');
  const [inputPerM, setInputPerM] = useState('3.0');
  const [outputPerM, setOutputPerM] = useState('15.0');
  const [cacheReadPerM, setCacheReadPerM] = useState('0.3');
  const [cacheWritePerM, setCacheWritePerM] = useState('3.75');
  const [cacheWrite1hPerM, setCacheWrite1hPerM] = useState('6.0');
  const [showBuiltinPrices, setShowBuiltinPrices] = useState(false);

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['ai-usage'] });
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

  const handleSaveDevice = (d: Device, nextHidden?: boolean) => {
    const name = (editingDeviceNames[d.device_id] ?? d.name).trim() || d.device_id;
    updateDevMut.mutate({ deviceId: d.device_id, name, hidden: nextHidden ?? d.hidden });
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
      {notice && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs text-slate-700">
          {notice}
        </div>
      )}

      {/* 1. Devices */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">设备与探针</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            探针首次上报时自动注册设备；隐藏退役设备后默认看板将不计入该设备，但历史记录保留。
          </p>
        </div>
        {loadingDevices ? (
          <div className="text-xs text-slate-500">加载中...</div>
        ) : devices.length === 0 ? (
          <div className="text-xs text-slate-500">暂无已上报设备。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">设备名称</th>
                  <th className="py-2 pr-3 font-medium">Device ID</th>
                  <th className="py-2 pr-3 font-medium">系统 / 架构</th>
                  <th className="py-2 pr-3 font-medium">探针版本</th>
                  <th className="py-2 pr-3 font-medium">最近同步</th>
                  <th className="py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {devices.map((d) => (
                  <tr key={d.device_id} className={d.hidden ? 'opacity-50' : ''}>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5">
                        <input
                          value={editingDeviceNames[d.device_id] ?? d.name}
                          onChange={(e) =>
                            setEditingDeviceNames((prev) => ({ ...prev, [d.device_id]: e.target.value }))
                          }
                          className="w-40 rounded border border-slate-200 px-2 py-1 text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveDevice(d)}
                          className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          保存
                        </button>
                      </div>
                    </td>
                    <td className="py-2 pr-3 font-mono text-slate-600">{d.device_id}</td>
                    <td className="py-2 pr-3 text-slate-600">
                      {[d.os, d.arch].filter(Boolean).join('/') || '-'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-slate-600">{d.collector_version || '-'}</td>
                    <td className="py-2 pr-3 text-slate-600">{formatDateTime(d.last_synced_at)}</td>
                    <td className="py-2 text-right space-x-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleSaveDevice(d, !d.hidden)}
                        className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-slate-700 hover:bg-slate-50"
                        title={d.hidden ? '取消隐藏' : '隐藏设备'}
                      >
                        {d.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                        {d.hidden ? '显示' : '隐藏'}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteDevMut.mutate(d.device_id)}
                        className="inline-flex items-center rounded border border-rose-200 p-1 text-rose-600 hover:bg-rose-50"
                        title="删除设备元信息"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 2. Model Aliases */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">模型别名规则</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            事实表保留原始模型名；匹配规则支持 <code className="font-mono">*</code> 通配符，priority 越小越优先，归一化后自动合并展示并复用标准单价。
          </p>
        </div>

        <form onSubmit={handleAliasSubmit} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <input
            required
            placeholder="匹配模式（如 my-relay/sonnet*）"
            value={aliasPattern}
            onChange={(e) => setAliasPattern(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-mono"
          />
          <input
            required
            placeholder="标准模型名（如 claude-sonnet-4.6）"
            value={aliasCanonical}
            onChange={(e) => setAliasCanonical(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-mono"
          />
          <input
            type="number"
            placeholder="优先级（默认 100）"
            value={aliasPriority}
            onChange={(e) => setAliasPriority(Number(e.target.value))}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
          />
          <button
            type="submit"
            disabled={saveAliasMut.isPending}
            className="inline-flex items-center justify-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            保存别名
          </button>
        </form>

        {loadingAliases ? (
          <div className="text-xs text-slate-500">加载中...</div>
        ) : aliases.length === 0 ? (
          <div className="text-xs text-slate-500">暂无自定义别名规则（当前使用内置前缀与日期后缀清洗）。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">匹配模式</th>
                  <th className="py-2 pr-3 font-medium">标准模型名</th>
                  <th className="py-2 pr-3 font-medium">优先级</th>
                  <th className="py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {aliases.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2 pr-3 font-mono text-slate-800">{a.match_pattern}</td>
                    <td className="py-2 pr-3 font-mono text-slate-800">{a.canonical_model}</td>
                    <td className="py-2 pr-3 text-slate-600">{a.priority}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => deleteAliasMut.mutate(a.id)}
                        className="inline-flex items-center rounded border border-rose-200 p-1 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Model Prices */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">模型单价（USD / 1M Tokens）</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              自定义单价优先覆盖内置默认单价，保存后所有历史统计即时按新单价重算。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowBuiltinPrices((v) => !v)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
          >
            {showBuiltinPrices ? '收起内置单价' : `查看内置单价 (${builtinPrices.length})`}
          </button>
        </div>

        <form onSubmit={handlePriceSubmit} className="grid grid-cols-2 sm:grid-cols-7 gap-2">
          <input
            required
            placeholder="模型模式（如 claude-sonnet-4.6）"
            value={pricePattern}
            onChange={(e) => setPricePattern(e.target.value)}
            className="col-span-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-mono"
          />
          <input
            type="number"
            step="any"
            min="0"
            placeholder="Input"
            title="Input USD / 1M"
            value={inputPerM}
            onChange={(e) => setInputPerM(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <input
            type="number"
            step="any"
            min="0"
            placeholder="Output"
            title="Output USD / 1M"
            value={outputPerM}
            onChange={(e) => setOutputPerM(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <input
            type="number"
            step="any"
            min="0"
            placeholder="Cache Read"
            title="Cache Read USD / 1M"
            value={cacheReadPerM}
            onChange={(e) => setCacheReadPerM(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <input
            type="number"
            step="any"
            min="0"
            placeholder="Cache Write"
            title="Cache Write (5m) USD / 1M"
            value={cacheWritePerM}
            onChange={(e) => setCacheWritePerM(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <div className="flex gap-1.5">
            <input
              type="number"
              step="any"
              min="0"
              placeholder="Write 1h"
              title="Cache Write (1h) USD / 1M"
              value={cacheWrite1hPerM}
              onChange={(e) => setCacheWrite1hPerM(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
            />
            <button
              type="submit"
              disabled={savePriceMut.isPending}
              className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              保存
            </button>
          </div>
        </form>

        {loadingPrices ? (
          <div className="text-xs text-slate-500">加载中...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
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
              <tbody className="divide-y divide-slate-100">
                {customPrices.map((p) => (
                  <tr key={`custom-${p.id}`}>
                    <td className="py-2 pr-3 font-mono text-slate-900">{p.model_pattern}</td>
                    <td className="py-2 pr-3">${p.input_per_m}</td>
                    <td className="py-2 pr-3">${p.output_per_m}</td>
                    <td className="py-2 pr-3">${p.cache_read_per_m}</td>
                    <td className="py-2 pr-3">${p.cache_write_per_m}</td>
                    <td className="py-2 pr-3">${p.cache_write_1h_per_m}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => p.id && deletePriceMut.mutate(p.id)}
                        className="inline-flex items-center rounded border border-rose-200 p-1 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {customPrices.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-3 text-slate-500">
                      暂无自定义覆盖单价。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {showBuiltinPrices && (
          <div className="pt-3 border-t border-slate-100 overflow-x-auto">
            <div className="text-xs font-medium text-slate-600 mb-2">内置默认单价参考</div>
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">模型模式</th>
                  <th className="py-1.5 pr-3 font-medium">Input</th>
                  <th className="py-1.5 pr-3 font-medium">Output</th>
                  <th className="py-1.5 pr-3 font-medium">Cache Read</th>
                  <th className="py-1.5 pr-3 font-medium">Cache Write</th>
                  <th className="py-1.5 font-medium">Cache Write 1h</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {builtinPrices.map((p) => (
                  <tr key={`builtin-${p.model_pattern}`}>
                    <td className="py-1.5 pr-3 font-mono">{p.model_pattern}</td>
                    <td className="py-1.5 pr-3">${p.input_per_m}</td>
                    <td className="py-1.5 pr-3">${p.output_per_m}</td>
                    <td className="py-1.5 pr-3">${p.cache_read_per_m}</td>
                    <td className="py-1.5 pr-3">${p.cache_write_per_m}</td>
                    <td className="py-1.5">${p.cache_write_1h_per_m}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. Collector quick reference */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-2 text-xs text-slate-600">
        <h2 className="text-base font-semibold text-slate-900">探针接入参考（`collector/`）</h2>
        <p>
          先在「系统设置 → API Keys」签发具备 <code className="font-mono text-slate-800">ai-usage:ingest</code>{' '}
          权限的密钥，然后在各开发机执行：
        </p>
        <pre className="rounded-lg bg-slate-900 p-3 text-slate-100 overflow-x-auto font-mono">
{`yukideck-collector init --server ${serverOrigin} --api-key ydk_xxx --device-name my-laptop
yukideck-collector doctor
yukideck-collector sync --all`}
        </pre>
      </section>
    </div>
  );
}
