export type UserTextContent = string | readonly string[];

export interface UserText {
  text: UserTextContent;
  type: "user-text";
}

export interface UserMessageTextPart {
  text: string;
  type: "text";
}

export interface UserMessageImagePart {
  image: string;
  mediaType?: string;
  type: "image";
}

export type UserMessageFileData =
  | string
  | { data: string; type: "data" }
  | { reference: Record<string, string>; type: "reference" }
  | { text: string; type: "text" }
  | { type: "url"; url: string };

export interface UserMessageFilePart {
  data: UserMessageFileData;
  filename?: string;
  mediaType: string;
  type: "file";
}

export type UserMessageContentPart =
  | UserMessageFilePart
  | UserMessageImagePart
  | UserMessageTextPart;

export type UserMessageContent = readonly UserMessageContentPart[];

export interface UserMessage {
  content: UserMessageContent;
  type: "user-message";
}

export type UserInput = UserMessage | UserText;
export type AgentInput =
  | readonly string[]
  | readonly UserMessageContentPart[]
  | string
  | UserInput;
export type SessionInput = AgentInput;
