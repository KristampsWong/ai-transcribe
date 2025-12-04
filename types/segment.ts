export type Segment = {
  id: string;
  english: string;
  chinese: string | null;
  status: "translating" | "done" | "error";
  error?: string;
  isQuestion: boolean;
  answer: {
    english: string;
    chinese: string;
  } | null;
  answerStatus: "pending" | "answering" | "done" | "error";
  answerError?: string;
};
