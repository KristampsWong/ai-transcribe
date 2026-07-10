// OpenAI Realtime 数据通道（data channel）下发的服务端事件类型定义。
// 会话形态：gpt-realtime-translate 翻译会话（单会话同时流式输出英文转写 + 中文翻译）。
//
// 官方文档（2026-05 发布）未完全锁定部分字段命名，因此本文件对不确定字段一律建模为“可选”，
// 具体读取时由 useRealtimeTranscription.ts 做防御性兜底（多候选字段名依次尝试），
// 不在类型层面强行假设某个字段一定存在。

// 英文源语转写：逐字增量。
export type RealtimeInputTranscriptDeltaEvent = {
  type: "session.input_transcript.delta";
  delta?: string;
  text?: string;
  item_id?: string;
  turn_id?: string;
  id?: string;
};

// 英文源语转写：整轮定稿。文本字段可能叫 transcript，也可能叫 text。
export type RealtimeInputTranscriptDoneEvent = {
  type: "session.input_transcript.done";
  transcript?: string;
  text?: string;
  item_id?: string;
  turn_id?: string;
  id?: string;
};

// 中文目标语翻译：逐字增量。
export type RealtimeOutputTranscriptDeltaEvent = {
  type: "session.output_transcript.delta";
  delta?: string;
  text?: string;
  item_id?: string;
  turn_id?: string;
  id?: string;
};

// 中文目标语翻译：整轮定稿。文本字段可能叫 transcript，也可能叫 text。
export type RealtimeOutputTranscriptDoneEvent = {
  type: "session.output_transcript.done";
  transcript?: string;
  text?: string;
  item_id?: string;
  turn_id?: string;
  id?: string;
};

// 中文语音（base64 PCM）增量。本项目只做文字展示，不播放语音，
// 识别该类型仅为了不把它误判成“未知事件”打进 console.debug。
export type RealtimeOutputAudioDeltaEvent = {
  type: "session.output_audio.delta";
  delta?: string;
  item_id?: string;
  turn_id?: string;
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
  | RealtimeInputTranscriptDeltaEvent
  | RealtimeInputTranscriptDoneEvent
  | RealtimeOutputTranscriptDeltaEvent
  | RealtimeOutputTranscriptDoneEvent
  | RealtimeOutputAudioDeltaEvent
  | RealtimeErrorEvent;

// 兜底：未建模的服务端事件类型（真机联调时可能出现 session.created / response.* 等）。
// 只保证能读到 type 字段，供 console.debug 打印，不抛错、不参与业务逻辑。
export type RealtimeUnknownServerEvent = {
  type: string;
};

export type RealtimeServerEvent =
  | RealtimeKnownServerEvent
  | RealtimeUnknownServerEvent;
