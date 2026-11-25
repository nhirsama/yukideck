import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import {
  Bell,
  Calendar as CalendarIcon,
  Check,
  Clock,
  History,
  ListTodo,
  Pencil,
  Plus,
  Repeat,
  RotateCcw,
  Send,
  Trash2,
} from 'lucide-react';
import {
  formatOffsetLabel,
  formatRepeatLabel,
  getLunarDayBadge,
  plannerApi,
  type PlannerItem,
} from './api';
import { ItemModal } from './ItemModal';

type TabKey = 'list' | 'calendar' | 'logs';
type ListFilter = 'pending' | 'today' | 'upcoming' | 'undated' | 'done';

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

export default function PlannerPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>('list');
  const [filter, setFilter] = useState<ListFilter>('pending');
  const [quickTitle, setQuickTitle] = useState('');
  const [modalState, setModalState] = useState<{
    open: boolean;
    item: PlannerItem | null;
    prefillDate?: string;
  }>({ open: false, item: null });
  const [calRange, setCalRange] = useState(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  });
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 2500);
  };

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
    queryKey: ['planner', 'logs'],
    queryFn: plannerApi.listLogs,
    enabled: tab === 'logs',
  });

  const quickAddMut = useMutation({
    mutationFn: (title: string) => plannerApi.createItem({ title }),
    onSuccess: () => {
      setQuickTitle('');
      invalidateAll();
    },
    onError: (err: Error) => showToast(err.message),
  });

  const completeMut = useMutation({
    mutationFn: (id: number) => plannerApi.completeItem(id),
    onSuccess: (res) => {
      invalidateAll();
      if (res.item.repeat_type !== 'none') {
        showToast(`已推进至下一周期：${res.item.target_local || ''}`);
      }
    },
    onError: (err: Error) => showToast(err.message),
  });

  const reopenMut = useMutation({
    mutationFn: (id: number) => plannerApi.reopenItem(id),
    onSuccess: invalidateAll,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => plannerApi.deleteItem(id),
    onSuccess: invalidateAll,
  });

  const testMut = useMutation({
    mutationFn: (id: number) => plannerApi.testItem(id),
    onSuccess: () => showToast('测试推送已发送'),
    onError: (err: Error) => showToast(`推送失败：${err.message}`),
  });

  const filteredItems = useMemo(() => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;

    return items.filter((it) => {
      if (filter === 'done') return it.status === 'done';
      if (it.status !== 'pending') return false;
      if (filter === 'pending') return true;
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

      {toast && <div className="yd-notice">{toast}</div>}

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
          <div className="yd-segment">
            {(
              [
                ['pending', '全部'],
                ['today', '今日'],
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
            <div className="text-xs text-zinc-400">加载中...</div>
          ) : filteredItems.length === 0 ? (
            <div className="yd-empty p-10 text-xs">当前筛选下暂无事项。</div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map((it) => {
                const isDone = it.status === 'done';
                const repeatLabel = formatRepeatLabel(it.repeat_type, it.repeat_config);
                return (
                  <div
                    key={it.id}
                    className="group yd-card p-4 flex items-start justify-between gap-4 transition-colors hover:border-zinc-300"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <button
                        type="button"
                        title={
                          isDone
                            ? '恢复为待办'
                            : it.repeat_type !== 'none'
                              ? '完成本期并推进至下一周期'
                              : '标记完成'
                        }
                        onClick={() =>
                          isDone ? reopenMut.mutate(it.id) : completeMut.mutate(it.id)
                        }
                        className={`mt-0.5 h-[18px] w-[18px] rounded-[5px] border flex items-center justify-center shrink-0 transition-colors ${
                          isDone
                            ? 'bg-sky-500 border-sky-500 text-white'
                            : 'border-zinc-300 hover:border-sky-400'
                        }`}
                      >
                        {isDone ? <Check className="h-3 w-3" /> : null}
                      </button>

                      <div className="min-w-0 space-y-1">
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
                            {it.next_trigger_at && !isDone && (
                              <span className="text-zinc-400 ml-0.5">
                                下次推送：{formatDateTimeShort(it.next_trigger_at)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-0.5 shrink-0 opacity-75 group-hover:opacity-100 transition-opacity">
                      {!isDone && (
                        <button
                          type="button"
                          title="测试推送"
                          onClick={() => testMut.mutate(it.id)}
                          className="yd-btn-icon"
                        >
                          <Send className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {isDone && (
                        <button
                          type="button"
                          title="恢复待办"
                          onClick={() => reopenMut.mutate(it.id)}
                          className="yd-btn-icon"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="编辑"
                        onClick={() => setModalState({ open: true, item: it })}
                        className="yd-btn-icon"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="删除"
                        onClick={() => {
                          if (window.confirm(`确定删除「${it.title}」吗？`)) {
                            deleteMut.mutate(it.id);
                          }
                        }}
                        className="yd-btn-danger-icon"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
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
        <div className="yd-card p-5">
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
                <div className="w-full flex items-center justify-between gap-1">
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
                      className={`text-[10px] ${
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

      {/* TAB 3: Push History Logs */}
      {tab === 'logs' && (
        <div className="yd-card overflow-hidden">
          {logsLoading ? (
            <div className="p-6 text-xs text-zinc-400">加载推送历史...</div>
          ) : (logsData?.logs ?? []).length === 0 ? (
            <div className="p-10 text-center text-xs text-zinc-500">暂无定时推送记录。</div>
          ) : (
            <div className="divide-y divide-zinc-100">
              {(logsData?.logs ?? []).map((log) => (
                <div key={log.id} className="px-4 py-3 flex items-center justify-between gap-4 text-xs">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-zinc-900 truncate">{log.item_title}</span>
                      {log.trigger_label && (
                        <span className="yd-badge yd-badge-neutral">{log.trigger_label}</span>
                      )}
                      <span
                        className={`yd-badge ${
                          log.status === 'ok' ? 'yd-badge-emerald' : 'yd-badge-red'
                        }`}
                      >
                        {log.status === 'ok' ? '成功' : '失败'}
                      </span>
                    </div>
                    {log.error && <div className="text-red-600">{log.error}</div>}
                  </div>
                  <div className="text-zinc-400 shrink-0 tabular-nums">
                    {formatDateTimeShort(log.sent_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
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
    </div>
  );
}
