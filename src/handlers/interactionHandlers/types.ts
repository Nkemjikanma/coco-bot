import { BasePayload, DecryptedInteractionResponse } from "@towns-protocol/bot";

export type OnInteractionEventType = BasePayload & {
  response: DecryptedInteractionResponse;
  threadId: string | undefined;
};

export type FormCase =
  | false
  | {
      requestId: string;
      components: {
        id: string;
        component:
          | {
              value: {};
              case: "button";
            }
          | {
              value: {
                value: string;
              };
              case: "textInput";
            }
          | {
              case: undefined;
              value?: undefined | undefined;
            };
      }[];
    };
