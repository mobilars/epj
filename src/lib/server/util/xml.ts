/**
 * Minimal XML-byggeklosser for helsemeldingene (hodemelding, dialogmelding,
 * epikrise, henvisning) og oppgjørsfiler. Bevisst uten tredjepartsavhengigheter:
 * hele leveransen har null runtime-avhengigheter, noe som fjerner en hel klasse
 * av forsyningskjederisiko i et system som behandler helseopplysninger.
 */

export function escapeXml(v: string): string {
	return v
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export type XmlNode = {
	name: string;
	attributes?: Record<string, string | undefined>;
	children?: (XmlNode | null | undefined | false)[];
	text?: string | number | null;
};

export function el(
	name: string,
	textOrChildren?: string | number | null | (XmlNode | null | undefined | false)[],
	attributes?: Record<string, string | undefined>
): XmlNode {
	if (Array.isArray(textOrChildren)) return { name, children: textOrChildren, attributes };
	return { name, text: textOrChildren ?? null, attributes };
}

export function serialiser(node: XmlNode, innrykk = 0): string {
	const pad = '  '.repeat(innrykk);
	const attrs = Object.entries(node.attributes ?? {})
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
		.join('');
	const children = (node.children ?? []).filter(Boolean) as XmlNode[];
	if (children.length === 0) {
		if (node.text === null || node.text === undefined || node.text === '') {
			return `${pad}<${node.name}${attrs}/>`;
		}
		return `${pad}<${node.name}${attrs}>${escapeXml(String(node.text))}</${node.name}>`;
	}
	const inner = children.map((b) => serialiser(b, innrykk + 1)).join('\n');
	return `${pad}<${node.name}${attrs}>\n${inner}\n${pad}</${node.name}>`;
}

export function document(root: XmlNode): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n${serialiser(root)}\n`;
}

/**
 * Parser som gir et tre av noder. Brukes til å lese innkommende meldinger og
 * applikasjonskvitteringer.
 *
 * Den kaster på ugyldig input i stedet for å tolke den «så godt den kan»: en
 * melding som ikke lar seg lese skal gi en applikasjonskvittering med feilkode,
 * ikke en halvveis tolket melding. DTD og andre entiteter enn de fem
 * predefinerte støttes ikke - innkommende meldinger valideres mot XSD i
 * produksjonsoppsettet.
 */
export type ParsedNode = {
	name: string;
	attributes: Record<string, string>;
	children: ParsedNode[];
	text: string;
};

export function parseXml(xml: string): ParsedNode {
	const without = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
	let i = 0;

	function unescape(v: string): string {
		return v
			.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
			.replace(/&amp;/g, '&');
	}

	function require(betingelse: boolean, message: string): void {
		if (!betingelse) throw new Error(`Ugyldig XML: ${message} (posisjon ${i})`);
	}

	function parseNode(dybde: number): ParsedNode {
		require(dybde < 100, 'for dyp nøsting');
		while (i < without.length && without[i] !== '<') i++;
		require(i < without.length, 'fant ingen elementstart');
		i++; // '<'

		const nameStart = i;
		while (i < without.length && !/[\s/>]/.test(without[i])) i++;
		require(i < without.length, 'uavsluttet elementnavn');
		const name = without.slice(nameStart, i);
		require(name.length > 0, 'tomt elementnavn');

		const attributes: Record<string, string> = {};
		for (;;) {
			while (i < without.length && /\s/.test(without[i])) i++;
			require(i < without.length, 'uavsluttet starttagg');
			if (without[i] === '/' || without[i] === '>') break;

			const aStart = i;
			while (i < without.length && without[i] !== '=' && !/\s/.test(without[i]) && without[i] !== '>') i++;
			require(i < without.length && without[i] !== '>', 'uavsluttet attributtnavn');
			const aName = without.slice(aStart, i);
			while (i < without.length && without[i] !== '"' && without[i] !== "'" && without[i] !== '>') i++;
			require(i < without.length && without[i] !== '>', `attributtet ${aName} mangler verdi`);
			const quote = without[i++];
			const vStart = i;
			while (i < without.length && without[i] !== quote) i++;
			require(i < without.length, `uavsluttet verdi for attributtet ${aName}`);
			attributes[aName] = unescape(without.slice(vStart, i));
			i++;
		}

		if (without[i] === '/') {
			require(without[i + 1] === '>', 'forventet «/>»');
			i += 2;
			return { name, attributes, children: [], text: '' };
		}
		i++; // '>'

		const children: ParsedNode[] = [];
		let text = '';
		for (;;) {
			const next = without.indexOf('<', i);
			require(next !== -1, `elementet ${name} er ikke lukket`);
			text += without.slice(i, next);
			if (without[next + 1] === '/') {
				const slutt = without.indexOf('>', next);
				require(slutt !== -1, `uavsluttet sluttagg for ${name}`);
				i = slutt + 1;
				break;
			}
			i = next;
			children.push(parseNode(dybde + 1));
		}
		return { name, attributes, children, text: unescape(text).trim() };
	}

	return parseNode(0);
}

export function find(node: ParsedNode, path: string): ParsedNode | undefined {
	const parts = path.split('/');
	let current: ParsedNode | undefined = node;
	for (const d of parts) {
		current = current?.children.find((b) => lokaltName(b.name) === d);
		if (!current) return undefined;
	}
	return current;
}

export const lokaltName = (name: string): string => name.split(':').pop() ?? name;

export function textValue(node: ParsedNode | undefined, path: string): string | undefined {
	if (!node) return undefined;
	return find(node, path)?.text || undefined;
}
