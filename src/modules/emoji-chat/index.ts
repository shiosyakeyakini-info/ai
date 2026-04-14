import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import Message from '@/message.js';
import config from '@/config.js';
import Friend from '@/friend.js';
import got from 'got';
import loki from 'lokijs';
import OpenAI from 'openai';
import { ChatModel } from 'openai/resources.mjs';
import { Emoji } from '@/misskey/emoji.js';

type EmojiChatHist = {
	postId: string;
	createdAt: number;
	fromMention: boolean;
	history?: {
		role: string;
		content: string;
	}[];
};

type GeminiParts = {
	text?: string;
}[];
type GeminiSystemInstruction = {
	role: string;
	parts: [{text: string}]
};
type GeminiContents = {
	role: string;
	parts: GeminiParts;
};
type GeminiOptions = {
	contents?: GeminiContents[],
	systemInstruction?: GeminiSystemInstruction,
};

const TRIGGER_KEYWORDS = ['emoji-chat', 'emojichat', '絵文字チャット', 'えもじちゃっと'];

const GEMINI_20_FLASH_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';

const TIMEOUT_TIME = 1000 * 60 * 60 * 0.5; // 30分
const DEFAULT_EMOJI_UPDATE_INTERVAL = 1000 * 60 * 60 * 24; // 24時間
const DEFAULT_MAX_EMOJIS = 500;

export default class extends Module {
	public readonly name = 'emoji-chat';
	private emojiChatHist!: loki.Collection<EmojiChatHist>;
	private cachedEmojis: Emoji[] = [];
	private lastEmojiUpdate: number = 0;
	private emojiUpdateInterval: number = DEFAULT_EMOJI_UPDATE_INTERVAL;

	@bindThis
	public install() {
		this.emojiChatHist = this.ai.getCollection('emojiChatHist', {
			indices: ['postId']
		});

		// 絵文字更新間隔の設定（aichatEmojiUpdateIntervalMinutesを流用）
		if (config.aichatEmojiUpdateIntervalMinutes != undefined && !Number.isNaN(config.aichatEmojiUpdateIntervalMinutes)) {
			this.emojiUpdateInterval = 1000 * 60 * config.aichatEmojiUpdateIntervalMinutes;
		}

		// 絵文字データを初回取得
		this.updateEmojis();

		// 定期的に絵文字データを更新
		setInterval(() => this.updateEmojis(), this.emojiUpdateInterval);

		return {
			mentionHook: this.mentionHook,
			contextHook: this.contextHook,
			timeoutCallback: this.timeoutCallback,
		};
	}

	@bindThis
	private async updateEmojis() {
		try {
			this.log('Updating emoji cache...');
			const emojisResponse: any = await got.post(`${config.apiUrl}/emojis`, {
				json: {
					i: config.i
				}
			}).json();

			if (emojisResponse && emojisResponse.emojis) {
				this.cachedEmojis = emojisResponse.emojis;
				this.lastEmojiUpdate = Date.now();
				this.log(`Emoji cache updated: ${this.cachedEmojis.length} emojis loaded`);
			}
		} catch (err: unknown) {
			this.log('Error updating emoji cache');
			if (err instanceof Error) {
				this.log(`${err.name}\n${err.message}\n${err.stack}`);
			}
		}
	}

	@bindThis
	private getAvailableEmojis(): Emoji[] {
		const now = Date.now();
		if (this.cachedEmojis.length === 0 || now - this.lastEmojiUpdate > this.emojiUpdateInterval) {
			this.updateEmojis();
		}
		return this.cachedEmojis;
	}

	/**
	 * 利用可能な絵文字をフィルタ・サンプリングしてプロンプト用の文字列を構築
	 */
	@bindThis
	private buildEmojiListText(): { listText: string; validNames: Set<string> } {
		const allEmojis = this.getAvailableEmojis();
		const targetCategories = config.emojiChatTargetCategories ?? [];
		const maxEmojis = config.emojiChatMaxEmojis ?? DEFAULT_MAX_EMOJIS;

		// カテゴリフィルタ & localOnly除外
		let filtered = allEmojis.filter(e =>
			!e.localOnly && e.name != null &&
			(targetCategories.length === 0 || targetCategories.includes(e.category ?? ''))
		);

		// 上限を超える場合はランダムサンプリング
		if (filtered.length > maxEmojis) {
			filtered = filtered
				.map(e => ({ e, r: Math.random() }))
				.sort((a, b) => a.r - b.r)
				.slice(0, maxEmojis)
				.map(x => x.e);
		}

		const validNames = new Set<string>(filtered.map(e => e.name!));
		const listText = filtered
			.map(e => {
				const aliases = e.aliases && e.aliases.length > 0
					? ` (${e.aliases.join(', ')})`
					: '';
				return `:${e.name}:${aliases}`;
			})
			.join('\n');

		return { listText, validNames };
	}

	/**
	 * 絵文字チャット専用のシステムプロンプトを構築
	 */
	@bindThis
	private buildSystemPrompt(emojiListText: string, friendName: string | undefined, fromMention: boolean): string {
		let basePrompt = '';
		if (config.prompt) {
			basePrompt = config.prompt + '\n\n';
		}

		let systemText = basePrompt + `あなたはカスタム絵文字だけで会話するチャットモードです。

【絶対ルール】
- テキスト（文字・数字・記号・Unicode絵文字）は一切使用禁止です。
- 返答は :emojiname: 形式のカスタム絵文字ショートコードのみで構成してください。
- 使用できるのは以下のリストにある絵文字のみです。リストにない絵文字は使用禁止です。
- 1回の返答で10〜30個の絵文字を使ってください。
- 絵文字の選択はユーザーのメッセージの感情・内容・文脈に合わせてください。
- 複数の絵文字を使う場合、半角スペースで区切ってください。

【使用可能なカスタム絵文字リスト】
${emojiListText}
`;

		if (friendName != undefined) {
			systemText += `\nなお、会話相手の名前は${friendName}です。`;
		}
		if (!fromMention) {
			systemText += '\nこのメッセージはあなたに向けたものではないかもしれませんが、絵文字で反応してください。';
		}

		return systemText;
	}

	/**
	 * ChatGPTで絵文字応答を生成
	 */
	@bindThis
	private async genEmojisByChatGPT(
		systemPrompt: string,
		history: { role: string; content: string }[] | undefined,
		question: string
	): Promise<string | null> {
		if (!config.openAiApiKey || !config.openAiModel) return null;
		this.log('Generate Emojis By ChatGPT...');

		try {
			const client = new OpenAI({
				apiKey: config.openAiApiKey,
			});

			const messages: any[] = [
				{ role: 'system', content: systemPrompt },
			];

			if (history != null) {
				history.forEach(entry => {
					messages.push({
						role: entry.role === 'model' ? 'assistant' : entry.role,
						content: entry.content
					});
				});
			}

			messages.push({ role: 'user', content: question });

			const response = await client.chat.completions.create({
				model: config.openAiModel as ChatModel,
				messages: messages,
			});

			return response.choices[0].message.content;
		} catch (err: unknown) {
			this.log('Error By Call ChatGPT');
			if (err instanceof Error) {
				this.log(`${err.name}\n${err.message}\n${err.stack}`);
			}
			return null;
		}
	}

	/**
	 * Geminiで絵文字応答を生成
	 */
	@bindThis
	private async genEmojisByGemini(
		systemPrompt: string,
		history: { role: string; content: string }[] | undefined,
		question: string
	): Promise<string | null> {
		if (!config.geminiProApiKey) return null;
		this.log('Generate Emojis By Gemini...');

		const systemInstruction: GeminiSystemInstruction = {
			role: 'system',
			parts: [{ text: systemPrompt }]
		};

		const contents: GeminiContents[] = [];
		if (history != null) {
			history.forEach(entry => {
				contents.push({
					role: entry.role,
					parts: [{ text: entry.content }],
				});
			});
		}
		contents.push({ role: 'user', parts: [{ text: question }] });

		const geminiOptions: GeminiOptions = {
			contents: contents,
			systemInstruction: systemInstruction,
		};

		const apiKey = config.geminiProApiKey;
		try {
			const res_data: any = await got.post(GEMINI_20_FLASH_API, {
				searchParams: { key: apiKey },
				json: geminiOptions,
				parseJson: (res: string) => JSON.parse(res),
			}).json();

			let responseText = '';
			if (res_data?.candidates?.length > 0) {
				const parts = res_data.candidates[0]?.content?.parts ?? [];
				for (const part of parts) {
					if (part.text) {
						responseText += part.text;
					}
				}
			}
			return responseText || null;
		} catch (err: unknown) {
			this.log('Error By Call Gemini');
			if (err instanceof Error) {
				this.log(`${err.name}\n${err.message}\n${err.stack}`);
			}
			return null;
		}
	}

	/**
	 * LLM出力から有効な絵文字のみ抽出して組み立てる
	 */
	@bindThis
	private validateAndFormatEmojis(rawText: string, validNames: Set<string>): string {
		const matches = [...rawText.matchAll(/:([^\s:]+?):/g)];
		const valid = matches
			.map(m => m[1])
			.filter(name => validNames.has(name));

		if (valid.length === 0) {
			// フォールバック: キャッシュから適当に数個選ぶ
			const names = Array.from(validNames);
			if (names.length === 0) return '';
			const fallbackCount = Math.min(3, names.length);
			const picked: string[] = [];
			for (let i = 0; i < fallbackCount; i++) {
				picked.push(names[Math.floor(Math.random() * names.length)]);
			}
			return picked.map(n => `:${n}:`).join(' ');
		}

		return valid.map(n => `:${n}:`).join(' ');
	}

	@bindThis
	private async mentionHook(msg: Message) {
		if (!msg.includes(TRIGGER_KEYWORDS)) {
			return false;
		}
		this.log('EmojiChat requested');

		// 会話中かチェック
		const conversationData: any = await this.ai.api('notes/conversation', { noteId: msg.id });
		if (conversationData != undefined) {
			for (const message of conversationData) {
				const exist = this.emojiChatHist.findOne({ postId: message.id });
				if (exist != null) return false;
			}
		}

		const current: EmojiChatHist = {
			postId: msg.id,
			createdAt: Date.now(),
			fromMention: true,
		};

		const result = await this.handleEmojiChat(current, msg);

		if (result) {
			return { reaction: 'like' };
		}
		return false;
	}

	@bindThis
	private async contextHook(key: any, msg: Message) {
		this.log('EmojiChat contextHook...');
		if (msg.text == null) return false;

		const conversationData: any = await this.ai.api('notes/conversation', { noteId: msg.id });
		if (conversationData == null || conversationData.length == 0) {
			return false;
		}

		let exist: EmojiChatHist | null = null;
		for (const message of conversationData) {
			exist = this.emojiChatHist.findOne({ postId: message.id });
			if (exist != null) break;
		}
		if (exist == null) {
			return false;
		}

		this.unsubscribeReply(key);
		this.emojiChatHist.remove(exist);

		const result = await this.handleEmojiChat(exist, msg);

		if (result) {
			return { reaction: 'like' };
		}
		return false;
	}

	@bindThis
	private async handleEmojiChat(exist: EmojiChatHist, msg: Message) {
		const extractedText = msg.extractedText;
		if (extractedText == undefined || extractedText.length == 0) return false;

		// トリガーキーワードをテキストから除去
		let question = extractedText.replace(RegExp(this.name, 'i'), '');
		for (const kw of TRIGGER_KEYWORDS) {
			question = question.replace(RegExp(kw, 'gi'), '');
		}
		question = question.trim();

		// APIキーがない場合
		if (!config.openAiApiKey && !config.geminiProApiKey) {
			msg.reply(serifs.emojiChat.nothing);
			return false;
		}

		// 絵文字リスト構築
		const { listText, validNames } = this.buildEmojiListText();
		if (validNames.size === 0) {
			msg.reply(serifs.emojiChat.error);
			return false;
		}

		// 会話相手の名前
		const friend: Friend | null = this.ai.lookupFriend(msg.userId);
		let friendName: string | undefined;
		if (friend != null && friend.name != null) {
			friendName = friend.name;
		} else if (msg.user.name) {
			friendName = msg.user.name;
		} else {
			friendName = msg.user.username;
		}

		const systemPrompt = this.buildSystemPrompt(listText, friendName, exist.fromMention);

		// LLM呼び出し（ChatGPT優先、Geminiフォールバック）
		let rawText: string | null = null;
		if (config.openAiApiKey && config.openAiModel) {
			rawText = await this.genEmojisByChatGPT(systemPrompt, exist.history, question);
		}
		if ((rawText == null || rawText === '') && config.geminiProApiKey) {
			rawText = await this.genEmojisByGemini(systemPrompt, exist.history, question);
		}

		if (rawText == null || rawText === '') {
			this.log('No response from LLM');
			msg.reply(serifs.emojiChat.error);
			return false;
		}

		// 応答バリデーション＆整形
		const emojiText = this.validateAndFormatEmojis(rawText, validNames);
		if (emojiText === '') {
			msg.reply(serifs.emojiChat.error);
			return false;
		}

		this.log('Replying with emojis...');
		msg.reply(serifs.emojiChat.post(emojiText)).then(reply => {
			if (!exist.history) {
				exist.history = [];
			}
			exist.history.push({ role: 'user', content: question });
			exist.history.push({ role: 'model', content: emojiText });
			if (exist.history.length > 10) {
				exist.history.shift();
			}
			this.emojiChatHist.insertOne({
				postId: reply.id,
				createdAt: Date.now(),
				fromMention: exist.fromMention,
				history: exist.history,
			});

			// 返信を待ち受け（正しい3引数形式）
			this.subscribeReply(reply.id, false, reply.id);

			// タイマーセット
			this.setTimeoutWithPersistence(TIMEOUT_TIME, {
				id: reply.id
			});
		});
		return true;
	}

	@bindThis
	private async timeoutCallback({ id }) {
		this.log('timeoutCallback...');
		const exist = this.emojiChatHist.findOne({ postId: id });
		this.unsubscribeReply(id);
		if (exist != null) {
			this.emojiChatHist.remove(exist);
		}
	}
}
