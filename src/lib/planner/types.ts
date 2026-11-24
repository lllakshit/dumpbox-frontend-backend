/** Planner shapes returned by /v1/planner/*. Shared by the server and the web client. */
export type EntryKind = "event" | "task"
export type ListKind = "calendar" | "tasks"

export type PlannerList = {
  id: string
  kind: ListKind
  name: string
  color: string
  is_default: boolean
  hidden: boolean
  position: number
  version: number
  created_at: string
  updated_at: string
}

export type Entry = {
  id: string
  kind: EntryKind
  list_id: string | null
  parent_id: string | null
  title: string
  notes: string | null
  location: string | null
  all_day: boolean
  start_at: string | null
  end_at: string | null
  start_date: string | null
  end_date: string | null
  time_zone: string | null
  rrule: string | null
  exdates: string[]
  reminders: number[]
  color: string | null
  completed_at: string | null
  starred: boolean
  position: number
  source_item_id: string | null
  external_id: string | null
  deleted_at: string | null
  version: number
  created_at: string
  updated_at: string
}

/** Columns read for an entry (everything except user_id). */
export const ENTRY_COLUMNS =
  "id,kind,list_id,parent_id,title,notes,location,all_day,start_at,end_at,start_date,end_date,time_zone,rrule,exdates,reminders,color,completed_at,starred,position,source_item_id,external_id,deleted_at,version,created_at,updated_at"
export const LIST_COLUMNS = "id,kind,name,color,is_default,hidden,position,version,created_at,updated_at"

/** Planner preferences, kept in the account's profile. */
export type PlannerPrefs = {
  week_start: 0 | 1 | 6
  default_event_minutes: number
  default_event_reminders: number[]
  default_task_reminders: number[]
  all_day_reminder_time: string
}

export const DEFAULT_PREFS: PlannerPrefs = {
  week_start: 1,
  default_event_minutes: 60,
  default_event_reminders: [10],
  default_task_reminders: [0],
  all_day_reminder_time: "09:00",
}

export const LIST_COLORS = ["#3a5bd9", "#1e8a52", "#c0392b", "#d97706", "#8e44ad", "#0e7490", "#db2777", "#4b5563", "#65a30d", "#b45309"]

/** "15 minutes before", "1 hour before", "1 day before", "At start". */
export function reminderLabel(min: number, allDay = false): string {
  if (min === 0) return allDay ? "On the day" : "At start time"
  if (min % 10080 === 0) return `${min / 10080} week${min === 10080 ? "" : "s"} before`
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"} before`
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"} before`
  return `${min} minutes before`
}

export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080]
