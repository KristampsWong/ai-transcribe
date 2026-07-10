// OpenAI Realtime 数据通道（data channel）下发的服务端事件类型定义。
// 会话形态：gpt-realtime-whisper 纯转写会话（无 VAD，客户端静音检测 + 手动 commit 分段）。
//
// 官方文档未完全锁定部分字段命名，因此本文件对不确定字段一律建模为“可选”，
// 具体读取时由 useRealtimeTranscription.ts 做防御性兜底（多候选字段名依次尝试），
// 不在类型层面强行假设某个字段一定存在。

// 转写：逐字增量。
export type RealtimeTranscriptionDeltaEvent = {
  type: "conversation.item.input_audio_transcription.delta";
  delta?: string;
  text?: string;
  item_id?: string;
  id?: string;
};

// 转写：整段定稿（client 端手动 commit 触发）。文本字段可能叫 transcript，也可能叫 text。
export type RealtimeTranscriptionCompletedEvent = {
  type: "conversation.item.input_audio_transcription.completed";
  transcript?: string;
  text?: string;
  item_id?: string;
  id?: string;
};

export type RealtimeErrorEvent = {
  type: "error";
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

export type RealtimeKnownServerEvent =
  | RealtimeTranscriptionDeltaEvent
  | RealtimeTranscriptionCompletedEvent
  | RealtimeErrorEvent;

// 兜底：未建模的服务端事件类型（真机联调时可能出现 session.created、
// input_audio_buffer.committed / speech_started 等，无 VAD 时后两者不会出现）。
// 只保证能读到 type 字段，供 console.debug 打印，不抛错、不参与业务逻辑。
export type RealtimeUnknownServerEvent = {
  type: string;
};

export type RealtimeServerEvent =
  | RealtimeKnownServerEvent
  | RealtimeUnknownServerEvent;
