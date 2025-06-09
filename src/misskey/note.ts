import { User } from "./user.js";

export type Note = {
	id: string;
	text: string | null;
	reply: any | null;
	user: User,
	poll?: {
		choices: {
			votes: number;
			text: string;
		}[];
		expiredAfter: number;
		multiple: boolean;
	} | null;
};
