/**
 * 聊天路由处理
 * POST 接口处理聊天请求
 * DELETE接口处理聊天删除
 */
import {
  type Message,
  convertToCoreMessages,
  createDataStreamResponse,
  streamObject,
  streamText,
} from 'ai';
import { z } from 'zod';

import { auth } from '@/app/(auth)/auth';
import { customModel } from '@/lib/ai';
import { models } from '@/lib/ai/models';
import {
  codePrompt,
  systemPrompt,
  updateDocumentPrompt,
} from '@/lib/ai/prompts';
import {
  deleteChatById,
  getChatById,
  getDocumentById,
  saveChat,
  saveDocument,
  saveMessages,
  saveSuggestions,
} from '@/lib/db/queries';
import type { Suggestion } from '@/lib/db/schema';
import {
  generateUUID,
  getMostRecentUserMessage,
  sanitizeResponseMessages,
} from '@/lib/utils';

import { generateTitleFromUserMessage } from '../../actions';

/** 最大执行时间(秒) */
export const maxDuration = 60;

/** 允许的工具类型 */
type AllowedTools =
  | 'createDocument'  // 创建文档
  | 'updateDocument'  // 更新文档
  | 'requestSuggestions'  // 请求建议
  | 'getWeather';     // 获取天气

/** 文档相关工具 */
const blocksTools: AllowedTools[] = [
  'createDocument',
  'updateDocument',
  'requestSuggestions',
];

/** 天气相关工具 */
const weatherTools: AllowedTools[] = ['getWeather'];

/** 所有可用工具 */
const allTools: AllowedTools[] = [...blocksTools, ...weatherTools];

/**
 * 处理聊天消息请求
 * 
 * @param request - HTTP请求对象
 * @returns 流式响应或错误响应
 */
export async function POST(request: Request) {
  // 解析请求体
  const {
    id,
    messages,
    modelId,
  }: { id: string; messages: Array<Message>; modelId: string } =
    await request.json();
  
  console.log('========== DEBUG: 请求体内容 ==========');
  console.log('会话ID:', id);
  console.log('选用模型:', modelId);
  console.log('消息数组:', messages);
  console.log('=====================================');

  // 验证用户会话
  const session = await auth();
  if (!session || !session.user || !session.user.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 查找并验证模型
  const model = models.find((model) => model.id === modelId);
  if (!model) {
    return new Response('Model not found', { status: 404 });
  }

  // 转换消息格式并获取最新用户消息
  const coreMessages = convertToCoreMessages(messages);
  console.log('[DEBUG] 转换后的核心消息:', {
    messageCount: coreMessages.length,
    lastMessage: coreMessages[coreMessages.length - 1]
  });

  const userMessage = getMostRecentUserMessage(coreMessages);
  if (!userMessage) {
    return new Response('No user message found', { status: 400 });
  }

  // 获取或创建聊天记录
  const chat = await getChatById({ id });
  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: userMessage });
    await saveChat({ id, userId: session.user.id, title });
  }
  console.log('[DEBUG] 聊天记录状态:', {
    isNewChat: !chat,
    chatId: id
  });


  // 生成消息ID并保存用户消息
  const userMessageId = generateUUID();
  await saveMessages({
    messages: [
      { ...userMessage, id: userMessageId, createdAt: new Date(), chatId: id },
    ],
  });

  // 流式响应
  return createDataStreamResponse({
    execute: (dataStream) => {
      console.log('[DEBUG] 开始流式响应处理');

      // 写入用户消息ID
      dataStream.writeData({
        type: 'user-message-id',
        content: userMessageId,
      });
      console.log('[DEBUG] 写入用户消息ID:', { userMessageId });

      // 配置流式文本响应
      const result = streamText({
        model: customModel(model.apiIdentifier),
        system: systemPrompt,
        messages: coreMessages,
        maxSteps: 5,
        experimental_activeTools: allTools,
        tools: {
          /**
           * 天气查询工具
           * 通过经纬度获取天气信息
           */
          getWeather: {
            description: 'Get the current weather at a location',
            parameters: z.object({
              latitude: z.number(),
              longitude: z.number(),
            }),
            execute: async ({ latitude, longitude }) => {
              console.log('[DEBUG] 调用天气工具:', { latitude, longitude });
              const response = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&hourly=temperature_2m&daily=sunrise,sunset&timezone=auto`,
              );

              const weatherData = await response.json();
              console.log('[DEBUG] 天气工具响应:', weatherData);
              return weatherData;
            },
          },
          
          /**
           * 文档创建工具
           * 根据标题和类型生成文档内容
           */
          createDocument: {
            description:
              'Create a document for a writing activity. This tool will call other functions that will generate the contents of the document based on the title and kind.',
            parameters: z.object({
              title: z.string(),
              kind: z.enum(['text', 'code']),
            }),
            execute: async ({ title, kind }) => {
              console.log('[DEBUG] 创建文档:', { title, kind });
              const id = generateUUID();
              let draftText = '';
              
              // 写入文档元数据
              dataStream.writeData({
                type: 'id',
                content: id,
              });
              dataStream.writeData({
                type: 'title',
                content: title,
              });
              dataStream.writeData({
                type: 'kind',
                content: kind,
              });
              dataStream.writeData({
                type: 'clear',
                content: '',
              });

              // 根据类型生成内容
              if (kind === 'text') {
                // 文本类型文档
                console.log('[DEBUG] 开始生成文本文档');
                const { fullStream } = streamText({
                  model: customModel(model.apiIdentifier),
                  system:
                    'Write about the given topic. Markdown is supported. Use headings wherever appropriate.',
                  prompt: title,
                });

                // 处理文本流
                for await (const delta of fullStream) {
                  console.log('[DEBUG] 文本增量:', {
                    type: delta.type,
                    content: delta.type === 'text-delta' ? delta.textDelta : null
                  });
                  
                  const { type } = delta;

                  if (type === 'text-delta') {
                    const { textDelta } = delta;

                    // 累积文本内容
                    draftText += textDelta;
                    dataStream.writeData({
                      type: 'text-delta',
                      content: textDelta,
                    });
                  }
                }
                
                // 标记已完成
                dataStream.writeData({ type: 'finish', content: '' });
              } else if (kind === 'code') {
                // 代码类型文档
                console.log('[DEBUG] 生成代码类型文档');
                const { fullStream } = streamObject({
                  model: customModel(model.apiIdentifier),
                  system: codePrompt,
                  prompt: title,
                  // 代码响应结构
                  schema: z.object({
                    code: z.string(),
                  }),
                });

                // 处理代码流
                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'object') {
                    const { object } = delta;
                    const { code } = object;

                    if (code) {
                      dataStream.writeData({
                        type: 'code-delta',
                        content: code ?? '',
                      });

                      draftText = code;
                    }
                  }
                }
                
                // 标记完成
                dataStream.writeData({ type: 'finish', content: '' });
              }

              // 保存生成的文档
              if (session.user?.id) {
                await saveDocument({
                  id,
                  title,
                  kind,
                  content: draftText,
                  userId: session.user.id,
                });
              }

              return {
                id,
                title,
                kind,
                content:
                  'A document was created and is now visible to the user.',
              };
            },
          },
          /**
           * 文档更新工具
           * 根据描述更新现有文档
           */
          updateDocument: {
            description: 'Update a document with the given description.',
            parameters: z.object({
              id: z.string().describe('The ID of the document to update'),
              description: z
                .string()
                .describe('The description of changes that need to be made'),
            }),
            execute: async ({ id, description }) => {
              const document = await getDocumentById({ id });

              if (!document) {
                return {
                  error: 'Document not found',
                };
              }

              const { content: currentContent } = document;
              let draftText = '';

              dataStream.writeData({
                type: 'clear',
                content: document.title,
              });

              if (document.kind === 'text') {
                const { fullStream } = streamText({
                  model: customModel(model.apiIdentifier),
                  system: updateDocumentPrompt(currentContent, 'text'),
                  prompt: description,
                  experimental_providerMetadata: {
                    openai: {
                      prediction: {
                        type: 'content',
                        content: currentContent,
                      },
                    },
                  },
                });

                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'text-delta') {
                    const { textDelta } = delta;

                    draftText += textDelta;
                    dataStream.writeData({
                      type: 'text-delta',
                      content: textDelta,
                    });
                  }
                }

                dataStream.writeData({ type: 'finish', content: '' });
              } else if (document.kind === 'code') {
                const { fullStream } = streamObject({
                  model: customModel(model.apiIdentifier),
                  system: updateDocumentPrompt(currentContent, 'code'),
                  prompt: description,
                  schema: z.object({
                    code: z.string(),
                  }),
                });

                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'object') {
                    const { object } = delta;
                    const { code } = object;

                    if (code) {
                      dataStream.writeData({
                        type: 'code-delta',
                        content: code ?? '',
                      });

                      draftText = code;
                    }
                  }
                }

                dataStream.writeData({ type: 'finish', content: '' });
              }

              if (session.user?.id) {
                await saveDocument({
                  id,
                  title: document.title,
                  content: draftText,
                  kind: document.kind,
                  userId: session.user.id,
                });
              }

              return {
                id,
                title: document.title,
                kind: document.kind,
                content: 'The document has been updated successfully.',
              };
            },
          },
          /**
           * 建议生成工具
           * 为文档生成改进建议
           */
          requestSuggestions: {
            description: 'Request suggestions for a document',
            parameters: z.object({
              documentId: z
                .string()
                .describe('The ID of the document to request edits'),
            }),
            execute: async ({ documentId }) => {
              const document = await getDocumentById({ id: documentId });

              if (!document || !document.content) {
                return {
                  error: 'Document not found',
                };
              }

              const suggestions: Array<
                Omit<Suggestion, 'userId' | 'createdAt' | 'documentCreatedAt'>
              > = [];

              const { elementStream } = streamObject({
                model: customModel(model.apiIdentifier),
                system:
                  'You are a help writing assistant. Given a piece of writing, please offer suggestions to improve the piece of writing and describe the change. It is very important for the edits to contain full sentences instead of just words. Max 5 suggestions.',
                prompt: document.content,
                output: 'array',
                schema: z.object({
                  originalSentence: z
                    .string()
                    .describe('The original sentence'),
                  suggestedSentence: z
                    .string()
                    .describe('The suggested sentence'),
                  description: z
                    .string()
                    .describe('The description of the suggestion'),
                }),
              });

              for await (const element of elementStream) {
                const suggestion = {
                  originalText: element.originalSentence,
                  suggestedText: element.suggestedSentence,
                  description: element.description,
                  id: generateUUID(),
                  documentId: documentId,
                  isResolved: false,
                };

                dataStream.writeData({
                  type: 'suggestion',
                  content: suggestion,
                });

                suggestions.push(suggestion);
              }

              if (session.user?.id) {
                const userId = session.user.id;

                await saveSuggestions({
                  suggestions: suggestions.map((suggestion) => ({
                    ...suggestion,
                    userId,
                    createdAt: new Date(),
                    documentCreatedAt: document.createdAt,
                  })),
                });
              }

              return {
                id: documentId,
                title: document.title,
                kind: document.kind,
                message: 'Suggestions have been added to the document',
              };
            },
          },
        },
        
        /**
         * 响应完成处理
         * 清理和保存生成的消息
         */
        onFinish: async ({ response }) => {
          console.log('[DEBUG] 响应完成，准备保存消息:', {
            messageCount: response.messages.length
          });

          if (session.user?.id) {
            try {
              // 清理未完成的工具调用
              const responseMessagesWithoutIncompleteToolCalls =
                sanitizeResponseMessages(response.messages);

              // 保存处理后的消息
              await saveMessages({
                messages: responseMessagesWithoutIncompleteToolCalls.map(
                  (message) => {
                    const messageId = generateUUID();

                    // 助手消息添加ID注解
                    if (message.role === 'assistant') {
                      dataStream.writeMessageAnnotation({
                        messageIdFromServer: messageId,
                      });
                    }

                    // 构建消息对象
                    return {
                      id: messageId,
                      chatId: id,
                      role: message.role,
                      content: message.content,
                      createdAt: new Date(),
                    };
                  },
                ),
              });
            } catch (error) {
              console.error('Failed to save chat');
            }
          }
        },
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'stream-text',
        },
      });

      // 合并数据流
      result.mergeIntoDataStream(dataStream);
      console.log('[DEBUG] 数据流合并完成');
    },
  });
}

/**
 * 删除聊天记录
 * 
 * @param request - HTTP请求对象
 * @returns 成功或错误响应
 */
export async function DELETE(request: Request) {
  // 获取聊天ID
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  // 验证用户会话
  const session = await auth();
  if (!session || !session.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // 验证聊天所有权
    const chat = await getChatById({ id });
    if (chat.userId !== session.user.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 删除聊天记录
    await deleteChatById({ id });
    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request', {
      status: 500,
    });
  }
}
