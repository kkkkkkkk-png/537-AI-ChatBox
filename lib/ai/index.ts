/**
 * AI 对话模块配置
 * 创建自定义openai客户端
 * 配置代理API
 * 包装语言模型
 */
import { createOpenAI } from '@ai-sdk/openai';
import { experimental_wrapLanguageModel as wrapLanguageModel } from 'ai';

import { customMiddleware } from './custom-middleware';

/**
 * 创建自定义 OpenAI 客户端
 * 支持代理 API 和第三方兼容模式
 */
const customOpenAI = createOpenAI({
  baseURL: process.env.OPENAI_API_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
  compatibility: 'compatible'  // 对第三方API使用兼容模式
});

/**
 * 创建包装后的语言模型实例
 * @param apiIdentifier - 模型标识符
 * @returns 包装后的语言模型
 */
export const customModel = (apiIdentifier: string) => {
  console.log('[DEBUG] 创建模型实例:', {
    apiIdentifier,
    baseURL: process.env.OPENAI_API_BASE_URL
  });
  
  return wrapLanguageModel({
    model: customOpenAI(apiIdentifier),
    middleware: customMiddleware,
  });
};
