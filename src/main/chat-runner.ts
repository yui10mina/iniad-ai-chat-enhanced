/** 質問 1 件の実行と、その結果を履歴・資料へ保存する処理。IPC からは切り離してある。 */
import { AppError, toSerializableError } from "../shared/types/errors";
import type { ChatResponse, ChatTurn } from "../shared/types/chat";
import type { AppSettings } from "../shared/types/settings";
import { toAssistantTurn } from "../shared/utils/assistant-turn";
import type { AgentTraceSink } from "./services/agent-trace";
import type { ChatAgent } from "./services/chat-agent";
import type { InMemoryStore, MaterialContextInput } from "./services/in-memory-store";

export interface ChatRunnerDeps {
  store: InMemoryStore;
  chatAgent: Pick<ChatAgent, "chat">;
  getSettings: () => AppSettings;
  /** 実行の記録を受け取る先。本文や検索語は渡らない。 */
  traceSinks?: readonly AgentTraceSink[];
  /**
   * 回答の前に MCP の接続を整える。接続できなくても回答は続けるので、
   * 失敗は例外にせず、キャンセルされたときだけ例外にする。
   * 待つものがないときは何も返さない。その場合は待たずに回答の生成を始める。
   */
  prepareMcp: (signal: AbortSignal) => Promise<void> | void;
}

export class ChatRunner {
  private activeController: AbortController | null = null;
  private activeCompletion: Promise<void> | null = null;

  constructor(private readonly deps: ChatRunnerDeps) {}

  /** 回答を生成中かどうか。 */
  get isRunning(): boolean {
    return this.activeController !== null;
  }

  /**
   * 質問を実行する。呼び出し側は、生成中でないことを先に確かめる。
   * traceSinks は、この質問の間だけ使う記録先（質問を送ったウィンドウへの進捗など）。
   */
  async send(
    userText: string,
    options: { traceSinks?: readonly AgentTraceSink[] } = {}
  ): Promise<ChatResponse> {
    const controller = new AbortController();
    this.activeController = controller;
    const task = this.run(userText, controller, options.traceSinks ?? []);
    const completion = task.then(
      () => undefined,
      () => undefined
    );
    this.activeCompletion = completion;

    try {
      return await task;
    } finally {
      if (this.activeController === controller) this.activeController = null;
      if (this.activeCompletion === completion) this.activeCompletion = null;
    }
  }

  /** 生成中の回答を止め、止まるのを最大 5 秒待つ。 */
  async cancel(): Promise<void> {
    const controller = this.activeController;
    const completion = this.activeCompletion;
    controller?.abort();
    if (completion) await waitAtMost(completion, 5_000);
  }

  private async run(
    userText: string,
    controller: AbortController,
    requestTraceSinks: readonly AgentTraceSink[]
  ): Promise<ChatResponse> {
    const { store, chatAgent } = this.deps;
    const settings = this.deps.getSettings();
    const userMessage: ChatTurn = {
      id: `msg_${Date.now()}_user`,
      role: "user",
      content: userText,
      timestamp: new Date().toISOString(),
    };
    // 失敗したときにも残せるよう、取得した資料は try の外で持つ。
    const retrievedMaterials: MaterialContextInput[] = [];

    try {
      // 待つものがないときまで await すると、回答の生成の開始が 1 ティック遅れる。
      const preparing = this.deps.prepareMcp(controller.signal);
      if (preparing) await preparing;

      if (controller.signal.aborted) {
        throw new AppError("CHAT_CANCELLED", "リクエストがキャンセルされました");
      }

      const priorMaterials = store.selectRelevantMaterials(userText);
      const response = await chatAgent.chat(
        userText,
        settings,
        controller.signal,
        [...store.getHistory(), userMessage],
        {
          priorMaterials,
          onMaterialsRetrieved: (materials) => {
            retrievedMaterials.push(...materials);
          },
          traceSinks: [...(this.deps.traceSinks ?? []), ...requestTraceSinks],
        }
      );

      // A dependency may resolve after cancellation instead of rejecting. Never
      // repopulate history/material state after new-chat, clear, or cancel returned.
      if (controller.signal.aborted) {
        throw new AppError("CHAT_CANCELLED", "リクエストがキャンセルされました");
      }

      store.markMaterialsReferenced(priorMaterials.map((material) => material.id));
      store.addMaterials(retrievedMaterials);

      const assistantMessage = toAssistantTurn(
        response,
        `msg_${Date.now()}_ai`,
        new Date().toISOString()
      );
      // 未確定ターンを先に履歴へ入れない。失敗時のrollbackで上限履歴を失わないため、
      // user/assistant は回答確定後にまとめてcommitする。
      store.addMessage(userMessage);
      store.addMessage(assistantMessage);
      return response;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AppError("CHAT_CANCELLED", "リクエストがキャンセルされました");
      }
      // 途中で失敗しても、読み終えた資料は次の質問で使えるように残す。
      // キャンセルは利用者が打ち切った操作なので、上の分岐で何も残さずに終える。
      // 履歴は増やさず、使った資料の参照順も変えない（回答が確定していないため）。
      store.addMaterials(retrievedMaterials);
      const serialized = toSerializableError(error);
      throw new AppError(serialized.code, serialized.message);
    }
  }
}

/** promise の完了を最大 timeoutMs だけ待つ。失敗しても例外にしない。 */
export async function waitAtMost(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}
