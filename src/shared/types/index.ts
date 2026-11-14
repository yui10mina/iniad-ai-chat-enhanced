/**
 * 共通型定義の barrel export
 * すべての型を1箇所から import 可能にする
 */
export type {
  ChatTurn,
  Citation,
  ChatProgress,
  ChatProgressTool,
  ChatResponse,
  ChatCompletionResponse,
  MaterialContextSummary,
} from "./chat";

export type {
  AppSettings,
  PublicAppSettings,
  PartialAppSettings,
  AppStatus,
  McpStatus,
  McpConnectionState,
  McpConnectionError,
  McpCredentialTestInput,
  ConnectionTestResult,
} from "./settings";

export { CHAT_MODEL, DEFAULT_SETTINGS, OFFICIAL_API_HOST } from "./settings";

export type {
  SearchResult,
  CourseSummary,
  LectureLink,
  SlideLink,
  CacheEntry,
  SearchSource,
} from "./search";

export type { SyllabusIndex, CourseEntry, ScheduleEntry, CourseMatch } from "./syllabus";

export type { ErrorCode, SerializableError } from "./errors";
export { AppError, toSerializableError } from "./errors";
