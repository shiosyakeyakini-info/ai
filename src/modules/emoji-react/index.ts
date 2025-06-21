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

       private async fetchEmojis(): Promise<Emoji[]> {
               return ((await got.post(`${config.apiUrl}/emojis`, {
                       json: {
                               i: config.i,
                       },
               }).json()) as any)["emojis"];
       }

	@bindThis
	public install() {
		this.htl = this.ai.connection.useSharedConnection('homeTimeline');
		this.htl.on('note', this.onNote);

		return {};
	}

	@bindThis
	async defaultReact(note: Note): Promise<{reaction: string, immediate?: boolean} | undefined> {

		if (note.reply != null) return;
		if (note.text == null) return;
               const customEmojis = note.text.match(/:([^\n:]+?):/g);
               if (customEmojis) {
                       // カスタム絵文字が複数種類ある場合はキャンセル
                       if (!customEmojis.every((val, i, arr) => val === arr[0])) return;

                       this.log(`Custom emoji detected - ${customEmojis[0]}`);

                       const emojis = await this.fetchEmojis();
                       const name = customEmojis[0].slice(1, -1);
                       const exists = emojis.some(e => e.name === name || (e.aliases ?? []).includes(name));
                       if (!exists) return;

                       return {reaction: customEmojis[0]};
               }

		const emojis = parse(note.text).map(x => x.text);
		if (emojis.length > 0) {
			// 絵文字が複数種類ある場合はキャンセル
			if (!emojis.every((val, i, arr) => val === arr[0])) return;

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

               const emojis: Emoji[] = await this.fetchEmojis();

		const targetCategories = config.reactedAiChatTargetCategories;

               const useEmoji = emojis
                       .filter(e =>
                                       !e.localOnly && targetCategories.includes(e.category ?? '')
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
下記のリアクションから3つ提案してください。:reaction:形式を改行区切りで最大3つ返答してください。
リアクションの候補:
${useEmoji}`;

					const response = await client.chat.completions.create({
						model: config.openAiModel,
						messages: [
							{role: 'system', content: systemInstructionText},
							{role: 'user', content: note.text},
						],
					});
                                       this.log(`ChatGPT response: ${response.choices[0].message.content}, used tokens: ${response.usage?.total_tokens}`);

                                       const matches = response.choices[0].message.content?.match(/:[^\s:]+:/g);
                                       if (matches) {
                                               for (const m of matches.slice(0, 3)) {
                                                       const name = m.slice(1, -1);
                                                       if (emojis.some(e => e.name === name || (e.aliases ?? []).includes(name))) {
                                                               return m;
                                                       }
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
}
