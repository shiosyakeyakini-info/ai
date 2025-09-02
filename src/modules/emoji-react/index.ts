import { bindThis } from '@/decorators.js';
import { parse } from 'twemoji-parser';

import type { Note } from '@/misskey/note.js';
import Module from '@/module.js';
import Stream from '@/stream.js';
import config from '@/config.js';
import includes from '@/utils/includes.js';
import { sleep } from '@/utils/sleep.js';
import OpenAI from 'openai';
import got from 'got';
import { Emoji } from '@/misskey/emoji.js';

export default class extends Module {
	public readonly name = 'emoji-react';

	private htl: ReturnType<Stream['useSharedConnection']>;
	private cachedEmojis: Emoji[] = [];
	private lastEmojiUpdate: number = 0;
	private emojiUpdateInterval: number = 1000 * 60 * 60 * 24; // 24時間

	@bindThis
	public install() {
		this.htl = this.ai.connection.useSharedConnection('homeTimeline');
		this.htl.on('note', this.onNote);

		// 設定から絵文字更新間隔を読み込み
		if (config.aichatEmojiUpdateIntervalMinutes != undefined && !Number.isNaN(config.aichatEmojiUpdateIntervalMinutes)) {
			this.emojiUpdateInterval = 1000 * 60 * config.aichatEmojiUpdateIntervalMinutes;
		}

		// 絵文字データを初回取得
		this.updateEmojis();

		// 定期的に絵文字データを更新
		setInterval(() => this.updateEmojis(), this.emojiUpdateInterval);

		return {};
	}

	@bindThis
	async defaultReact(note: Note): Promise<{reaction: string, immediate?: boolean} | undefined> {

		if (note.reply != null) return;
		if (note.text == null) return;
		const customEmojis = note.text.match(/:([^\n:]+?):/g);
		if (customEmojis) {
			// カスタム絵文字が複数種類ある場合はキャンセル
			if (!customEmojis.every((val, _, arr) => val === arr[0])) return;

			this.log(`Custom emoji detected - ${customEmojis[0]}`);

			// カスタム絵文字がサーバーに存在するかチェック
			const emojiMatch = customEmojis[0].match(/:([^:]+):/);
			if (emojiMatch) {
				const emojiName = emojiMatch[1]; // コロンを除いた絵文字名
				const emojis = this.getAvailableEmojis();
				const existsInServer = emojis.some(emoji => emoji.name === emojiName);
				
				if (existsInServer) {
					return {reaction: customEmojis[0]};
				} else {
					this.log(`Custom emoji ${customEmojis[0]} does not exist on server, skipping...`);
					return;
				}
			} else {
				this.log(`Invalid custom emoji format: ${customEmojis[0]}`);
				return;
			}
		}

		const emojis = parse(note.text).map(x => x.text);
		if (emojis.length > 0) {
			// 絵文字が複数種類ある場合はキャンセル
			if (!emojis.every((val, _, arr) => val === arr[0])) return;

			this.log(`Emoji detected - ${emojis[0]}`);

			let reaction = emojis[0];

			switch (reaction) {
				case '✊': return {reaction: '🖐', immediate: true};
				case '✌': return {reaction: '✊', immediate: true};
				case '🖐': case '✋': return {reaction: '✌', immediate: true};
			}

			return {reaction};
		}

		if (includes(note.text, ['ぴざ'])) return { reaction: '🍕'};
		if (includes(note.text, ['ぷりん'])) return { reaction: '🍮'};
		if (includes(note.text, ['寿司', 'sushi']) || note.text === 'すし') return {reaction: '🍣'};

		if (includes(note.text, ['藍'])) return {reaction: '🙌'};

		return undefined;
	}

	@bindThis
	async chatGPTReact(note: Note): Promise<string | undefined> {

		if(!config.openAiApiKey) return;
		if(!config.openAiModel) return;
		
		if(
			note.user?.host !== null &&
			Math.random() > (config.reactedAiChatProbabilityInRemoteUser ?? 0.001)
		) return;
		if(
			note.user?.host === null &&
			Math.random() > (config.reactedAiChatProbabilityInLocalUser ?? 0.01)
		) return;

		const emojis: Emoji[] = this.getAvailableEmojis();

		const targetCategories = config.reactedAiChatTargetCategories ?? [];

		const useEmoji = emojis
			.filter(e => 
					!e.localOnly && (targetCategories.length === 0 || targetCategories.includes(e.category ?? ''))
			)
			.filter(() => Math.random() < (config.reactedAiChatTargetEmojisRatio ?? 1))
			.map((e) => `:${e.name}: ${e.aliases?.join(', ')}`)
			.join('\n');

		try {
					const client = new OpenAI({
						apiKey: config.openAiApiKey,
					});


					const systemInstructionText = `
あなたは、Misskeyのユーザーが投稿したノートに対して、適切なリアクションを提案するAIです。
あなたの提案は、ノートの内容に基づいて、ユーザーが喜ぶようなリアクションを選ぶことを目指してください。
下記のリアクションから一つを選択して、:reaction:形式で返答してください。
リアクションの候補:
${useEmoji}`;

					const response = await client.chat.completions.create({
						model: config.openAiModel,
						messages: [
							{role: 'system', content: systemInstructionText},
							{role: 'user', content: note.text || ''},
						],
					});
					this.log(`ChatGPT response: ${response.choices[0].message.content}, used tokens: ${response.usage?.total_tokens}`);
			
					const match = response.choices[0].message.content?.match(/:([^:]+):/);
					if (match) {
						// 提案されたリアクションが実際にサーバーに存在するかチェック
						const reactionName = match[1]; // コロンを除いた絵文字名
						const existsInServer = emojis.some(emoji => emoji.name === reactionName);
						if (existsInServer) {
							return match[0]; // :絵文字名: の形式で返す
						} else {
							this.log(`Suggested emoji ${match[0]} does not exist on server, skipping...`);
							return undefined;
						}
					}
					return undefined;
			
				} catch (err: unknown) {
					this.log('Error By Call ChatGPT');
					if (err instanceof Error) {
						this.log(`${err.name}\n${err.message}\n${err.stack}`);
					}
					return;
				}
	}

	@bindThis
	private async onNote(note: Note) {
		if (note.reply != null) return;
		if (note.text == null) return;
		if (note.text.includes('@')) return; // (自分または他人問わず)メンションっぽかったらreject

		const react = async (reaction: string, immediate = false) => {
			if (!immediate) {
				await sleep(1500);
			}
			this.ai.api('notes/reactions/create', {
				noteId: note.id,
				reaction: reaction
			});
		};

		const defaultReaction = await this.defaultReact(note);
		if (defaultReaction) {
			await react(defaultReaction.reaction, defaultReaction.immediate);
			return;
		}

		const chatGPTReaction = await this.chatGPTReact(note);
		if (chatGPTReaction) {
			await react(chatGPTReaction);
			return;
		}

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
		// キャッシュが古い場合や空の場合は更新を試みる
		const now = Date.now();
		if (this.cachedEmojis.length === 0 || now - this.lastEmojiUpdate > this.emojiUpdateInterval) {
			this.updateEmojis();
		}
		return this.cachedEmojis;
	}
}
