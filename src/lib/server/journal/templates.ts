import { exec, one, query } from '../db';
import { requireTenant } from '../tenant/context';
import { newId } from '../util/ids';

/**
 * A clinician's own templates for record notes.
 *
 * Every query is scoped to the practice *and* the owner. A template id arriving
 * from a form is never enough on its own: one clinician must not be able to
 * read, fill a note from, or delete another's template by guessing its id.
 */

export interface NoteTemplate {
	id: string;
	name: string;
	title: string;
	subjective: string;
	objective: string;
	assessment: string;
	updated_at: string;
}

export interface TemplateContent {
	name: string;
	title: string;
	subjective: string;
	objective: string;
	assessment: string;
}

export const TEMPLATE_LIMITS = { name: 80, title: 200, text: 10000 } as const;

const FIELDS = 'id, name, title, subjective, objective, assessment, updated_at';

export async function listTemplates(userId: string): Promise<NoteTemplate[]> {
	return query<NoteTemplate>(
		`SELECT ${FIELDS} FROM note_template WHERE tenant_id = $1 AND user_id = $2 ORDER BY lower(name)`,
		[requireTenant().id, userId]
	);
}

export async function getTemplate(userId: string, id: string): Promise<NoteTemplate | null> {
	return one<NoteTemplate>(
		`SELECT ${FIELDS} FROM note_template WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
		[requireTenant().id, userId, id]
	);
}

/**
 * What is wrong with the content, in words the clinician can act on, or null.
 * Norwegian, because it is shown as it stands.
 */
export function templateProblem(content: TemplateContent): string | null {
	if (!content.name) return 'Malen må ha et navn.';
	if (content.name.length > TEMPLATE_LIMITS.name) return `Navnet kan ikke være lengre enn ${TEMPLATE_LIMITS.name} tegn.`;
	if (content.title.length > TEMPLATE_LIMITS.title) return `Tittelen kan ikke være lengre enn ${TEMPLATE_LIMITS.title} tegn.`;
	for (const text of [content.subjective, content.objective, content.assessment]) {
		if (text.length > TEMPLATE_LIMITS.text) return `Et felt i malen er lengre enn ${TEMPLATE_LIMITS.text} tegn.`;
	}
	if (!content.subjective && !content.objective && !content.assessment) {
		return 'Malen er tom. Skriv noe i minst ett av feltene først.';
	}
	return null;
}

/**
 * Saves the template under its name, replacing one of the same name.
 *
 * Saving over a name is how a template is edited: fill the form from it,
 * change it, save it again under the same name. One way to do it rather than
 * a separate editor that has to be kept in step with the note form.
 */
export async function saveTemplate(userId: string, content: TemplateContent): Promise<string> {
	const row = await one<{ id: string }>(
		`INSERT INTO note_template (id, tenant_id, user_id, name, title, subjective, objective, assessment)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (tenant_id, user_id, name) DO UPDATE SET
		   title = EXCLUDED.title, subjective = EXCLUDED.subjective, objective = EXCLUDED.objective,
		   assessment = EXCLUDED.assessment, updated_at = now()
		 RETURNING id`,
		[newId(), requireTenant().id, userId, content.name, content.title, content.subjective, content.objective, content.assessment]
	);
	return row!.id;
}

export async function deleteTemplate(userId: string, id: string): Promise<boolean> {
	const count = await exec('DELETE FROM note_template WHERE tenant_id = $1 AND user_id = $2 AND id = $3', [
		requireTenant().id, userId, id
	]);
	return count > 0;
}
