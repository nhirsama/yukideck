import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import {
  AlertTriangle,
  Bell,
  Calendar as CalendarIcon,
  Check,
  CheckCheck,
  Clock,
  FastForward,
  History,
  ListTodo,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  RotateCcw,
  Send,
  Trash2,
} from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { useToast } from '@/components/Toast';
import { Tooltip } from '@/components/Tooltip';
import {
  formatLogReason,
  formatOffsetLabel,
  formatOverdueConfigLabel,
  formatOverdueElapsed,
  formatRepeatLabel,
  getLunarDayBadge,
  isItemOverdue,
  plannerApi,
  type LogStatus,
  type PlannerItem,
} from './api';
import { ItemModal } from './ItemModal';
import { NotificationModal } from './NotificationModal';
import { PauseModal } from './PauseModal';

type TabKey = 'list' | 'calendar' | 'logs';
type ListFilter = 'pending' | 'today' | 'overdue' | 'upcoming' | 'undated' | 'done';
type LogFilter = '' | LogStatus;

function formatDateTimeShort(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function logStatusBadge(status: LogStatus): { label: string; cls: string } {
  switch (status) {
    case 'ok':
      return { label: '成功', cls: 'yd-badge-emerald' };
    case 'retrying':
      return {
        label: '重试中',
        cls: 'bg-amber-50 text-amber-700 border border-amber-200/80',
      };
    case 'failed':
      return { label: '失败', cls: 'yd-badge-red' };
    case 'skipped':
      return { label: '已跳过', cls: 'yd-badge-neutral' };
  }
}

export default function PlannerPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>('list');
  const [filter, setFilter] = useState<ListFilter>('pending');
  const [logFilter, setLogFilter] = useState<LogFilter>('');
  const [quickTitle, setQuickTitle] = useState('');
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [modalState, setModalState] = useState<{
    open: boolean;
    item: PlannerItem | null;
    prefillDate?: string;
  }>({ open: false, item: null });
  const [notifyModalItem, setNotifyModalItem] = useState<PlannerItem | null>(null);
  const [pauseModalItem, setPauseModalItem] = useState<PlannerItem | null>(null);

  const [calRange, setCalRange] = useState(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  });
  const { showToast } = useToast();

  useEffect(() => {
    if (openMenuId === null) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpenMenuId(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuId(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuId]);

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['planner'] });
  };

  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: ['planner', 'items'],
    queryFn: plannerApi.listItems,
  });
  const items = itemsData?.items ?? [];

  const { data: calData } = useQuery({
    queryKey: ['planner', 'calendar', calRange.start, calRange.end],
    queryFn: () => plannerApi.listCalendar(calRange.start, calRange.end),
    enabled: tab === 'calendar',
  });

  const { data: logsData, isLoading: logsLoading } = useQuery({
    queryKey: ['planner', 'logs', logFilter],
    queryFn: () => plannerApi.listLogs(logFilter || undefined),
    enabled: tab === 'logs',
  });

  const quickAddMut = useMutation({
    mutationFn: (title: string) => plannerApi.createItem({ title }),
    onSuccess: () => {
      setQuickTitle('');
      invalidateAll();
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const completeMut = useMutation({
    mutationFn: (id: number) => plannerApi.completeItem(id),
    onSuccess: (res) => {
      invalidateAll();
      if (res.item.repeat_type !== 'none') {
        showToast(`已推进至下一周期：${res.item.target_local?.replace('T', ' ') || ''}`);
      }
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const finishMut = useMutation({
    mutationFn: (id: number) => plannerApi.finishItem(id),
    onSuccess: () => {
      invalidateAll();
      showToast('已标记为已完成');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const advanceCurrentMut = useMutation({
    mutationFn: (id: number) => plannerApi.advanceItemToCurrent(id),
    onSuccess: (res) => {
      invalidateAll();
      showToast(`已推进至当前周期：${res.item.target_local?.replace('T', ' ') || ''}`);
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const reopenMut = useMutation({
    mutationFn: (id: number) => plannerApi.reopenItem(id),
    onSuccess: invalidateAll,
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const resumeMut = useMutation({
    mutationFn: (id: number) => plannerApi.resumeItem(id),
    onSuccess: () => {
      invalidateAll();
      showToast('已恢复通知');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => plannerApi.deleteItem(id),
    onSuccess: invalidateAll,
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const testMut = useMutation({
    mutationFn: (id: number) => plannerApi.testItem(id),
    onSuccess: () => showToast('测试推送已发送'),
    onError: (err: Error) => showToast(`推送失败：${err.message}`, 'error'),
  });

  const overdueCount = useMemo(
    () => items.filter((it) => isItemOverdue(it)).length,
    [items],
  );

  const filteredItems = useMemo(() => {
    const now = new Date();
    const nowMs = now.getTime();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;

    return items.filter((it) => {
      if (filter === 'done') return it.status === 'done';
      if (it.status !== 'pending') return false;
      if (filter === 'pending') return true;
      if (filter === 'overdue') return isItemOverdue(it, nowMs);
      if (filter === 'undated') return !it.target_at;
      if (filter === 'today') return Boolean(it.target_local?.startsWith(todayStr));
      if (filter === 'upcoming') return Boolean(it.target_at);
      return true;
    });
  }, [items, filter]);

  const calendarEvents = useMemo(
    () =>
      (calData?.events ?? []).map((ev) => ({
        id: ev.id,
        title: ev.title,
        start: ev.start,
        backgroundColor: ev.status === 'done' ? '#f4f4f5' : ev.has_reminder ? '#e0f2fe' : '#f1f5f9',
        textColor: ev.status === 'done' ? '#94a3b8' : ev.has_reminder ? '#0369a1' : '#475569',
        borderColor: 'transparent',
        extendedProps: { itemId: ev.item_id },
      })),
    [calData?.events],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="yd-page-title">日程与提醒</h1>

        <button
          type="button"
          onClick={() => setModalState({ open: true, item: null })}
          className="yd-btn-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          新建事项
        </button>
      </div>

      {/* View Switch Tabs */}
      <div className="yd-tabs">
        {(
          [
            ['list', '清单', ListTodo],
            ['calendar', '日历', CalendarIcon],
            ['logs', '推送记录', History],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`yd-tab ${tab === key ? 'yd-tab-active' : 'yd-tab-idle'}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* TAB 1: Unified Todo & Schedule List */}
      {tab === 'list' && (
        <div className="space-y-4">
          {/* Quick-add pure Todo bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (quickTitle.trim()) quickAddMut.mutate(quickTitle.trim());
            }}
            className="yd-card flex items-center gap-2 px-3 py-1.5 focus-within:border-sky-300 focus-within:ring-2 focus-within:ring-sky-500/12 transition-colors"
          >
            <Plus className="h-4 w-4 text-zinc-400 shrink-0" />
            <input
              value={quickTitle}
              onChange={(e) => setQuickTitle(e.target.value)}
              placeholder="输入待办事项，回车快速添加..."
              className="flex-1 bg-transparent py-1.5 text-[13px] text-zinc-800 placeholder:text-zinc-400 outline-none"
            />
            {quickTitle.trim() && (
              <button
                type="submit"
                disabled={quickAddMut.isPending}
                className="yd-btn-primary py-1 px-3"
              >
                添加
              </button>
            )}
          </form>

          {/* Filter pills */}
          <div className="yd-segment-scroll">
            {(
              [
                ['pending', '全部'],
                ['today', '今日'],
                ['overdue', overdueCount > 0 ? `已逾期 (${overdueCount})` : '已逾期'],
                ['upcoming', '有时间'],
                ['undated', '无日期'],
                ['done', '已完成'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`yd-segment-btn ${filter === k ? 'yd-segment-active' : 'yd-segment-idle'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {itemsLoading ? (
            <LoadingState label="正在加载模块..." variant="section" />
          ) : filteredItems.length === 0 ? (
            <div className="yd-empty p-10 text-xs">当前筛选下暂无事项。</div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map((it) => {
                const isDone = it.status === 'done';
                const isRecurring = it.repeat_type !== 'none';
                const overdue = isItemOverdue(it);
                const hasPushConfig =
                  it.remind_offsets.length > 0 || Boolean(it.overdue_config?.enabled);
                const repeatLabel = formatRepeatLabel(it.repeat_type, it.repeat_config);
                const overdueCfgLabel = formatOverdueConfigLabel(it.overdue_config);
                const menuOpen = openMenuId === it.id;

                return (
                  <div
                    key={it.id}
                    className={`group yd-card p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-2.5 sm:gap-4 transition-colors hover:border-zinc-300 ${
                      overdue && !it.paused ? 'border-red-200/80' : ''
                    }`}
                  >
                    <div className="min-w-0 space-y-1 flex-1">
                      <div
                        className={`text-[13px] font-medium leading-snug ${
                          isDone ? 'line-through text-zinc-400' : 'text-zinc-900'
                        }`}
                      >
                        {it.title}
                      </div>
                      {it.note && (
                        <p className="text-xs text-zinc-500 whitespace-pre-wrap leading-relaxed">
                          {it.note}
                        </p>
                      )}

                      {(it.target_local ||
                        repeatLabel ||
                        it.remind_offsets.length > 0 ||
                        overdueCfgLabel ||
                        it.paused ||
                        it.retry_state ||
                        (it.next_trigger_at && !isDone)) && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11px] text-zinc-500 tabular-nums">
                          {it.target_local && (
                            <span className="yd-badge yd-badge-neutral">
                              <Clock className="h-3 w-3 text-zinc-400" />
                              {it.target_local.replace('T', ' ')}
                              {it.calendar_type === 'lunar' && it.lunar_label
                                ? ` · ${it.lunar_label}`
                                : ''}
                            </span>
                          )}
                          {overdue && it.target_at && (
                            <span className="yd-badge yd-badge-red">
                              <AlertTriangle className="h-3 w-3" />
                              {formatOverdueElapsed(it.target_at)}
                            </span>
                          )}
                          {it.paused && (
                            <span className="yd-badge bg-amber-50 text-amber-700 border border-amber-200/80">
                              <Pause className="h-3 w-3" />
                              {it.paused_until
                                ? `已暂停至 ${formatDateTimeShort(it.paused_until)}`
                                : '已一直暂停'}
                            </span>
                          )}
                          {!it.paused && it.retry_state && (
                            <span className="yd-badge bg-amber-50 text-amber-700 border border-amber-200/80">
                              <RefreshCw className="h-3 w-3" />
                              重试中（下次 {formatDateTimeShort(it.retry_state.next_retry_at)}）
                            </span>
                          )}
                          {repeatLabel && (
                            <span className="yd-badge yd-badge-sky">
                              <Repeat className="h-3 w-3" />
                              {repeatLabel}
                            </span>
                          )}
                          {it.remind_offsets.map((o) => (
                            <span
                              key={`${o.unit}:${o.value}`}
                              className="yd-badge yd-badge-emerald"
                            >
                              <Bell className="h-3 w-3" />
                              {formatOffsetLabel(o)}
                            </span>
                          ))}
                          {overdueCfgLabel && (
                            <span className="yd-badge yd-badge-neutral">
                              {overdueCfgLabel}
                            </span>
                          )}
                          {it.next_trigger_at && !isDone && !it.paused && (
                            <span className="text-zinc-400 ml-0.5">
                              下次推送：{formatDateTimeShort(it.next_trigger_at)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Right action bar: [Check] [Bell?] [Pause/Resume?] [Edit?] [More...] */}
                    <div className="flex items-center justify-end sm:justify-start gap-0.5 shrink-0 pt-2 border-t border-zinc-100 sm:pt-0 sm:border-0">
                      {!isDone && (
                        <Tooltip
                          content={
                            isRecurring
                              ? '确认本期并推进至下一周期'
                              : '确认完成'
                          }
                        >
                          <button
                            type="button"
                            onClick={() => completeMut.mutate(it.id)}
                            className="yd-btn-icon text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      )}

                      {!isDone && it.target_at && (
                        <Tooltip content="通知配置">
                          <button
                            type="button"
                            onClick={() => setNotifyModalItem(it)}
                            className={`yd-btn-icon ${
                              hasPushConfig ? 'text-sky-600 hover:text-sky-700' : ''
                            }`}
                          >
                            <Bell className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      )}

                      {!isDone && it.target_at && (
                        <Tooltip content={it.paused ? '恢复通知' : '暂停通知'}>
                          <button
                            type="button"
                            onClick={() => {
                              if (it.paused) {
                                resumeMut.mutate(it.id);
                              } else {
                                setPauseModalItem(it);
                              }
                            }}
                            className={`yd-btn-icon ${
                              it.paused ? 'text-amber-600 hover:text-amber-700 hover:bg-amber-50' : ''
                            }`}
                          >
                            {it.paused ? (
                              <Play className="h-3.5 w-3.5" />
                            ) : (
                              <Pause className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </Tooltip>
                      )}

                      {!isDone && (
                        <Tooltip content="修改">
                          <button
                            type="button"
                            onClick={() => setModalState({ open: true, item: it })}
                            className="yd-btn-icon"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      )}

                      <div className="relative" ref={menuOpen ? menuRef : undefined}>
                        <Tooltip content="更多操作" disabled={menuOpen}>
                          <button
                            type="button"
                            onClick={() => setOpenMenuId(menuOpen ? null : it.id)}
                            className="yd-btn-icon"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>

                        {menuOpen && (
                          <div className="absolute right-0 mt-1.5 w-40 rounded-xl border border-zinc-200/90 bg-white py-1 shadow-lg z-30">
                            {!isDone ? (
                              <>
                                {isRecurring && overdue && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenMenuId(null);
                                      advanceCurrentMut.mutate(it.id);
                                    }}
                                    className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2"
                                  >
                                    <FastForward className="h-3.5 w-3.5 text-sky-500 shrink-0" />
                                    推进至当前周期
                                  </button>
                                )}
                                {isRecurring && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenMenuId(null);
                                      finishMut.mutate(it.id);
                                    }}
                                    className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2"
                                  >
                                    <CheckCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                                    标记为已完成
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenMenuId(null);
                                    testMut.mutate(it.id);
                                  }}
                                  className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2"
                                >
                                  <Send className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                                  测试通知
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  reopenMut.mutate(it.id);
                                }}
                                className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2"
                              >
                                <RotateCcw className="h-3.5 w-3.5 text-zinc-400" />
                                恢复待办
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuId(null);
                                if (window.confirm(`确定删除「${it.title}」吗？`)) {
                                  deleteMut.mutate(it.id);
                                }
                              }}
                              className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50/70 flex items-center gap-2"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: FullCalendar with Solar + Lunar Display */}
      {tab === 'calendar' && (
        <div className="yd-card p-3 sm:p-5 overflow-x-auto">
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            locale="zh-cn"
            height="auto"
            headerToolbar={{
              left: 'prev,next today',
              center: 'title',
              right: 'dayGridMonth,timeGridWeek,timeGridDay',
            }}
            buttonText={{
              today: '今天',
              month: '月',
              week: '周',
              day: '日',
            }}
            events={calendarEvents}
            datesSet={(arg) => {
              setCalRange({ start: arg.start.toISOString(), end: arg.end.toISOString() });
            }}
            dayCellContent={(arg) => {
              const lunar = getLunarDayBadge(arg.date);
              return (
                <div className="w-full flex flex-col sm:flex-row items-center justify-between gap-0.5 sm:gap-1">
                  <span
                    className={`text-xs tabular-nums ${
                      arg.isToday
                        ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-500 font-medium text-white'
                        : 'font-medium text-zinc-700'
                    }`}
                  >
                    {arg.date.getDate()}
                  </span>
                  {lunar.text && (
                    <span
                      className={`text-[9px] sm:text-[10px] leading-tight truncate max-w-full ${
                        lunar.highlight ? 'text-sky-600 font-medium' : 'text-zinc-400'
                      }`}
                    >
                      {lunar.text}
                    </span>
                  )}
                </div>
              );
            }}
            dateClick={(info) => {
              setModalState({ open: true, item: null, prefillDate: info.dateStr });
            }}
            eventClick={(info) => {
              const itemId = Number(info.event.extendedProps.itemId);
              const found = items.find((x) => x.id === itemId);
              if (found) setModalState({ open: true, item: found });
            }}
          />
        </div>
      )}

      {/* TAB 3: Push & Diagnostic Logs */}
      {tab === 'logs' && (
        <div className="space-y-4">
          <div className="yd-segment-scroll">
            {(
              [
                ['', '全部'],
                ['ok', '成功'],
                ['retrying', '重试中'],
                ['failed', '失败'],
                ['skipped', '已跳过'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k || 'all'}
                type="button"
                onClick={() => setLogFilter(k)}
                className={`yd-segment-btn ${
                  logFilter === k ? 'yd-segment-active' : 'yd-segment-idle'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="yd-card overflow-hidden">
            {logsLoading ? (
              <LoadingState label="正在加载模块..." variant="section" />
            ) : (logsData?.logs ?? []).length === 0 ? (
              <div className="p-10 text-center text-xs text-zinc-500">
                当前筛选下暂无推送或诊断记录。
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {(logsData?.logs ?? []).map((log) => {
                  const badge = logStatusBadge(log.status);
                  const reasonText = formatLogReason(log.reason);
                  return (
                    <div
                      key={log.id}
                      className="px-3.5 sm:px-4 py-3 flex flex-col sm:flex-row sm:items-start justify-between gap-1.5 sm:gap-4 text-xs"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-zinc-900 truncate">
                            {log.item_title}
                          </span>
                          {log.trigger_label && (
                            <span className="yd-badge yd-badge-neutral">{log.trigger_label}</span>
                          )}
                          <span className={`yd-badge ${badge.cls}`}>{badge.label}</span>
                          {log.attempt > 1 && (
                            <span className="yd-badge yd-badge-neutral tabular-nums">
                              第 {log.attempt} 次尝试
                            </span>
                          )}
                        </div>
                        {reasonText && (
                          <div className="text-zinc-500">
                            {reasonText}
                            {log.status === 'retrying' && log.next_retry_at
                              ? ` · 下次重试：${formatDateTimeShort(log.next_retry_at)}`
                              : ''}
                          </div>
                        )}
                        {log.error && <div className="text-red-600 break-all">{log.error}</div>}
                      </div>
                      <div className="text-zinc-400 shrink-0 tabular-nums">
                        {formatDateTimeShort(log.sent_at)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {modalState.open && (
        <ItemModal
          initial={modalState.item}
          prefillDate={modalState.prefillDate}
          onClose={() => setModalState({ open: false, item: null })}
          onSaved={() => {
            setModalState({ open: false, item: null });
            invalidateAll();
          }}
        />
      )}

      {notifyModalItem && (
        <NotificationModal
          item={notifyModalItem}
          onClose={() => setNotifyModalItem(null)}
          onSaved={() => {
            setNotifyModalItem(null);
            invalidateAll();
            showToast('通知配置已更新');
          }}
        />
      )}

      {pauseModalItem && (
        <PauseModal
          item={pauseModalItem}
          onClose={() => setPauseModalItem(null)}
          onSaved={() => {
            setPauseModalItem(null);
            invalidateAll();
            showToast('已暂停通知');
          }}
        />
      )}
    </div>
  );
}
