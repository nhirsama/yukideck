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
        backgroundColor: ev.status === 'done' ? '#94a3b8' : ev.has_reminder ? '#0f172a' : '#475569',
        borderColor: 'transparent',
        extendedProps: { itemId: ev.item_id },
      })),
    [calData?.events],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">日程与提醒</h1>
          <p className="text-sm text-slate-500 mt-1">
            统一管理待办、公历/农历计划与精确到分钟的多时间点独立推送。
          </p>
        </div>

        <button
          type="button"
          onClick={() => setModalState({ open: true, item: null })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          新建事项
        </button>
      </div>

      {/* View Switch Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {(
          [
            ['list', '清单视图', ListTodo],
            ['calendar', '日历视图', CalendarIcon],
            ['logs', '推送历史', History],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {toast && (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-700">
          {toast}
        </div>
      )}

      {/* TAB 1: Unified Todo & Schedule List */}
      {tab === 'list' && (
        <div className="space-y-4">
          {/* Quick-add pure Todo bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (quickTitle.trim()) quickAddMut.mutate(quickTitle.trim());
            }}
            className="flex gap-2"
          >
            <input
              value={quickTitle}
              onChange={(e) => setQuickTitle(e.target.value)}
              placeholder="快速添加待办（仅输入标题回车即可，需要时间或推送点右上角「新建事项」）..."
              className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-slate-400"
            />
            <button
              type="submit"
              disabled={!quickTitle.trim() || quickAddMut.isPending}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              添加
            </button>
          </form>

          {/* Filter pills */}
          <div className="inline-flex flex-wrap rounded-lg border border-slate-200 bg-white p-1 text-xs">
            {(
              [
                ['pending', '全部待办'],
                ['today', '今日'],
                ['upcoming', '有时间计划'],
                ['undated', '无日期 Todo'],
                ['done', '已完成'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                  filter === k ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {itemsLoading ? (
            <div className="text-sm text-slate-500">加载中...</div>
          ) : filteredItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
              当前筛选下暂无事项。
            </div>
          ) : (
            <div className="space-y-2.5">
              {filteredItems.map((it) => {
                const isDone = it.status === 'done';
                const repeatLabel = formatRepeatLabel(it.repeat_type, it.repeat_config);
                return (
                  <div
                    key={it.id}
                    className="rounded-xl border border-slate-200 bg-white p-4 flex items-start justify-between gap-4 hover:border-slate-300 transition-colors"
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
                        className={`mt-0.5 h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                          isDone
                            ? 'bg-slate-900 border-slate-900 text-white'
                            : 'border-slate-300 hover:border-slate-900'
                        }`}
                      >
                        {isDone ? <Check className="h-3.5 w-3.5" /> : null}
                      </button>

                      <div className="min-w-0 space-y-1">
                        <div
                          className={`text-sm font-medium ${
                            isDone ? 'line-through text-slate-400' : 'text-slate-900'
                          }`}
                        >
                          {it.title}
                        </div>
                        {it.note && <p className="text-xs text-slate-500 whitespace-pre-wrap">{it.note}</p>}

                        <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px] text-slate-500">
                          {it.target_local && (
                            <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-slate-700">
                              <Clock className="h-3 w-3" />
                              {it.target_local.replace('T', ' ')}
                              {it.calendar_type === 'lunar' && it.lunar_label ? ` · ${it.lunar_label}` : ''}
                            </span>
                          )}
                          {repeatLabel && (
                            <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-blue-700">
                              <Repeat className="h-3 w-3" />
                              {repeatLabel}
                            </span>
                          )}
                          {it.remind_offsets.map((o) => (
                            <span
                              key={`${o.unit}:${o.value}`}
                              className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-emerald-700"
                            >
                              <Bell className="h-3 w-3" />
                              {formatOffsetLabel(o)}
                            </span>
                          ))}
                          {it.next_trigger_at && !isDone && (
                            <span className="text-slate-400">
                              下次推送：{formatDateTimeShort(it.next_trigger_at)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {!isDone && (
                        <button
                          type="button"
                          title="测试推送"
                          onClick={() => testMut.mutate(it.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100"
                        >
                          <Send className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {isDone && (
                        <button
                          type="button"
                          title="恢复待办"
                          onClick={() => reopenMut.mutate(it.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="编辑"
                        onClick={() => setModalState({ open: true, item: it })}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100"
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
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
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
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
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
                  <span className="text-xs font-medium text-slate-700">{arg.date.getDate()}</span>
                  {lunar.text && (
                    <span
                      className={`text-[10px] ${
                        lunar.highlight ? 'text-blue-600 font-medium' : 'text-slate-400'
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
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {logsLoading ? (
            <div className="p-6 text-sm text-slate-500">加载推送历史...</div>
          ) : (logsData?.logs ?? []).length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">暂无定时推送记录。</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {(logsData?.logs ?? []).map((log) => (
                <div key={log.id} className="px-4 py-3 flex items-center justify-between gap-4 text-xs">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900 truncate">{log.item_title}</span>
                      {log.trigger_label && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                          {log.trigger_label}
                        </span>
                      )}
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          log.status === 'ok'
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-red-50 text-red-700'
                        }`}
                      >
                        {log.status === 'ok' ? '成功' : '失败'}
                      </span>
                    </div>
                    {log.error && <div className="text-red-600">{log.error}</div>}
                  </div>
                  <div className="text-slate-400 shrink-0">{formatDateTimeShort(log.sent_at)}</div>
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
