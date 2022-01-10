import {
  DendronCompositeError,
  DendronError,
  IDendronError,
  NoteProps,
  ResponseUtil,
  RespV2,
} from "@dendronhq/common-all";
import { markdownToBlocks } from "@instantish/martian";
import { JSONSchemaType } from "ajv";
import { RateLimiter } from "limiter";
import _ from "lodash";
import {
  Client,
  ConfigFileUtils,
  ExportPodV2,
  NotionV2PodConfig,
  RunnableNotionV2PodConfig,
} from "../../..";

export type NotionExportReturnType = RespV2<{
  created?: NotionFields[];
}>;

export type NotionFields = {
  /**
   * Document Id of the notion doc created
   */
  notionId: string;
  /**
   *  dendron id of note
   */
  dendronId: string;
};

// Allow 3 req/sec (the Notion API limit). Also understands 'hour', 'minute', 'day', or a no. of ms
// @ts-ignore
const limiter = new RateLimiter({ tokensPerInterval: 3, interval: "second" });

/**
 * Notion Export Pod (V2 - for compatibility with Pod V2 workflow).
 */
export class NotionExportPodV2 implements ExportPodV2<NotionExportReturnType> {
  private _config: RunnableNotionV2PodConfig;
  private _client: Client;

  constructor({
    podConfig,
    notion,
  }: {
    podConfig: RunnableNotionV2PodConfig;
    notion: Client;
  }) {
    this._config = podConfig;
    this._client = notion;
  }

  async exportNote(input: NoteProps): Promise<NotionExportReturnType> {
    const response = await this.exportNotes([input]);
    return response;
  }

  async exportNotes(notes: NoteProps[]): Promise<NotionExportReturnType> {
    const { parentPageId } = this._config;
    const blockPagesArray = this.convertMdToNotionBlock(notes, parentPageId);
    const { data, errors } = await this.createPagesInNotion(
      blockPagesArray,
      this._client
    );
    const createdNotes = data.filter(
      (ent): ent is NotionFields => !_.isUndefined(ent)
    );

    if (errors.length > 0) {
      return {
        data: { created: createdNotes },
        error: new DendronCompositeError(errors),
      };
    } else {
      return ResponseUtil.createHappyResponse({
        data: {
          created: createdNotes,
        },
      });
    }
  }

  /**
   * Method to convert markdown to Notion Block
   */
  convertMdToNotionBlock = (notes: NoteProps[], parentPageId: string) => {
    const notionBlock = notes.map((note) => {
      const children = markdownToBlocks(note.body);
      return {
        dendronId: note.id,
        block: {
          parent: {
            page_id: parentPageId,
          },
          properties: {
            title: {
              title: [{ type: "text", text: { content: note.title } }],
            },
          },
          children,
        },
      };
    });
    return notionBlock;
  };

  /**
   * Method to create pages in Notion
   */
  createPagesInNotion = async (
    blockPagesArray: any,
    notion: Client
  ): Promise<{
    data: NotionFields[];
    errors: IDendronError[];
  }> => {
    const errors: IDendronError[] = [];
    const out: NotionFields[] = await Promise.all(
      blockPagesArray.map(async (ent: any) => {
        // @ts-ignore
        await limiter.removeTokens(1);
        try {
          const response = await notion.pages.create(ent.block);
          return {
            notionId: response.id,
            dendronId: ent.dendronId,
          };
        } catch (error) {
          errors.push(error as DendronError);
          return;
        }
      })
    );
    return {
      data: out,
      errors,
    };
  };

  static config(): JSONSchemaType<NotionV2PodConfig> {
    return ConfigFileUtils.createExportConfig({
      required: ["connectionId", "parentPageId"],
      properties: {
        connectionId: {
          description: "ID of the Notion Connected Service",
          type: "string",
        },
        parentPageId: {
          description: "ID of parent page in notion",
          type: "string",
        },
      },
    }) as JSONSchemaType<NotionV2PodConfig>;
  }
}
