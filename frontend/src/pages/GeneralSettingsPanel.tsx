import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Globe, Puzzle } from 'lucide-react';
import { Select } from '@/components/Select';
import { useToast } from '@/components/Toast';
import { coreApi, type UpdateUserPreferencesInput } from '@/core/api';
import { useAuth } from '@/core/auth';
import { useAvailableModules } from '@/core/module';
import {
  COMMON_TIMEZONES,
  DEFAULT_TIMEZONE,
  detectBrowserTimezone,
  formatDateTimeInTimezone,
  formatTimezoneOptionLabel,
  setActiveUserTimezone,
} from '@/core/timezone';

export function GeneralSettingsPanel() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const availableModules = useAvailableModules();
  const { showToast } = useToast();

  const browserTz = useMemo(() => detectBrowserTimezone(), []);
  const savedTz = user?.timezone || DEFAULT_TIMEZONE;
  const savedDisabled = useMemo(() => user?.disabled_modules ?? [], [user?.disabled_modules]);

  const [timezone, setTimezone] = useState(savedTz);
  const [nowTick, setNowTick] = useState(() => new Date());

  useEffect(() => {
    setTimezone(savedTz);
  }, [savedTz]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const timezoneOptions = useMemo(() => {
    const extras: Array<{ value: string; label: string }> = [];
    for (const candidate of [timezone, browserTz]) {
      if (
        candidate &&
        !COMMON_TIMEZONES.some((z) => z.value === candidate) &&
        !extras.some((z) => z.value === candidate)
      ) {
        extras.push({ value: candidate, label: formatTimezoneOptionLabel(candidate) });
      }
    }
    return [...extras, ...COMMON_TIMEZONES];
  }, [timezone, browserTz]);

  const previewTime = useMemo(
    () =>
      formatDateTimeInTimezone(nowTick, timezone, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hour12: false,
      }),
    [nowTick, timezone],
  );

  const mutation = useMutation({
    mutationFn: (payload: UpdateUserPreferencesInput) => coreApi.updatePreferences(payload),
    onSuccess: (res, variables) => {
      setActiveUserTimezone(res.user.timezone);
      qc.setQueryData(['core', 'me'], res.user);
      if (variables.timezone !== undefined) {
        // Refresh module queries that aggregate or format dates by user timezone.
        void qc.invalidateQueries({
          predicate: (q) => q.queryKey[0] !== 'core',
        });
      }
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : '保存偏好设置失败', 'error');
    },
  });

  const handleSaveTimezone = (nextTz: string) => {
    if (!nextTz || nextTz === savedTz) return;
    setTimezone(nextTz);
    mutation.mutate(
      { timezone: nextTz },
      {
        onSuccess: () => {
          showToast('全局默认时区已更新', 'info');
        },
      },
    );
  };

  const disabledSet = useMemo(() => new Set(savedDisabled), [savedDisabled]);

  const handleToggleModule = (moduleId: string, moduleName: string) => {
    const next = new Set(disabledSet);
    const willDisable = !next.has(moduleId);
    if (willDisable) {
      next.add(moduleId);
    } else {
      next.delete(moduleId);
    }
    mutation.mutate(
      { disabled_modules: Array.from(next) },
      {
        onSuccess: () => {
          showToast(
            willDisable ? `已关闭「${moduleName}」模块（历史数据已保留）` : `已开启「${moduleName}」模块`,
            'info',
          );
        },
      },
    );
  };

  const enabledCount = availableModules.filter((m) => !disabledSet.has(m.id)).length;

  return (
    <div className="space-y-5">
      {/* Global Default Timezone */}
      <section className="yd-card p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-lg bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
              <Globe className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-zinc-800">全局默认时区</h2>
              <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                用于 AI 用量、日程新建默认时区、资产日期计算及后续使用时间同步等全部模块。
              </p>
            </div>
          </div>

          {browserTz && browserTz !== timezone && (
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => handleSaveTimezone(browserTz)}
              className="yd-btn-secondary text-xs shrink-0 self-start sm:self-center"
            >
              使用当前浏览器时区 ({browserTz})
            </button>
          )}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
          <div className="w-full sm:w-96">
            <Select
              value={timezone}
              onChange={(val) => handleSaveTimezone(val)}
              options={timezoneOptions}
              disabled={mutation.isPending}
              size="md"
              searchable
              ariaLabel="全局默认时区"
            />
          </div>

          <div className="inline-flex items-center gap-1.5 text-xs text-zinc-500 tabular-nums">
            <Clock className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
            <span>当前时间：{previewTime}</span>
          </div>
        </div>
      </section>

      {/* Per-user Module Management */}
      <section className="yd-card p-4 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-lg bg-[#f3f6fa] text-zinc-600 flex items-center justify-center shrink-0">
              <Puzzle className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-zinc-800">功能模块管理</h2>
              <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                控制各模块的显示与隐藏，关闭后不会删除已有数据。
              </p>
            </div>
          </div>
          <span className="yd-badge yd-badge-neutral shrink-0 tabular-nums">
            已开启 {enabledCount} / {availableModules.length}
          </span>
        </div>

        {availableModules.length === 0 ? (
          <div className="yd-empty p-6 text-xs text-zinc-500">当前部署未启用任何可选业务模块</div>
        ) : (
          <div className="divide-y divide-zinc-100 border border-zinc-200/70 rounded-xl overflow-hidden">
            {availableModules.map((mod) => {
              const Icon = mod.icon;
              const isEnabled = !disabledSet.has(mod.id);
              return (
                <div
                  key={mod.id}
                  className="flex items-center justify-between gap-4 px-4 py-3.5 bg-white hover:bg-zinc-50/60 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                        isEnabled ? 'bg-sky-50 text-sky-600' : 'bg-zinc-100 text-zinc-400'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-medium truncate ${
                            isEnabled ? 'text-zinc-800' : 'text-zinc-400'
                          }`}
                        >
                          {mod.name}
                        </span>
                        <span className="font-mono text-[11px] text-zinc-400">{mod.id}</span>
                      </div>
                      <p className="text-xs text-zinc-500 truncate mt-0.5">{mod.description}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-label={`${isEnabled ? '关闭' : '开启'}${mod.name}`}
                    disabled={mutation.isPending}
                    onClick={() => handleToggleModule(mod.id, mod.name)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40 disabled:opacity-50 ${
                      isEnabled ? 'bg-sky-500' : 'bg-zinc-200'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ${
                        isEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
