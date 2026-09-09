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
	navn: string;
	attributter?: Record<string, string | undefined>;
	barn?: (XmlNode | null | undefined | false)[];
	tekst?: string | number | null;
};

export function el(
	navn: string,
	tekstEllerBarn?: string | number | null | (XmlNode | null | undefined | false)[],
	attributter?: Record<string, string | undefined>
): XmlNode {
	if (Array.isArray(tekstEllerBarn)) return { navn, barn: tekstEllerBarn, attributter };
	return { navn, tekst: tekstEllerBarn ?? null, attributter };
}

export function serialiser(node: XmlNode, innrykk = 0): string {
	const pad = '  '.repeat(innrykk);
	const attrs = Object.entries(node.attributter ?? {})
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
		.join('');
	const barn = (node.barn ?? []).filter(Boolean) as XmlNode[];
	if (barn.length === 0) {
		if (node.tekst === null || node.tekst === undefined || node.tekst === '') {
			return `${pad}<${node.navn}${attrs}/>`;
		}
		return `${pad}<${node.navn}${attrs}>${escapeXml(String(node.tekst))}</${node.navn}>`;
	}
	const inner = barn.map((b) => serialiser(b, innrykk + 1)).join('\n');
	return `${pad}<${node.navn}${attrs}>\n${inner}\n${pad}</${node.navn}>`;
}

export function dokument(rot: XmlNode): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n${serialiser(rot)}\n`;
}

/**
 * Enkel, ikke-validerende parser som gir et tre av noder. Brukes til å lese
 * innkommende meldinger og applikasjonskvitteringer i testmiljø.
 * Håndterer ikke DTD/entiteter utover de fem predefinerte - innkommende
 * meldinger fra meldingstjeneren valideres mot XSD i produksjonsoppsettet.
 */
export type ParsedNode = {
	navn: string;
	attributter: Record<string, string>;
	barn: ParsedNode[];
	tekst: string;
};

export function parseXml(xml: string): ParsedNode {
	const uten = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
	let i = 0;
	function unescape(s: string): string {
		return s
			.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
			.replace(/&amp;/g, '&');
	}
	function parseNode(): ParsedNode {
		while (uten[i] !== '<') i++;
		i++; // '<'
		const navnStart = i;
		while (!/[\s/>]/.test(uten[i])) i++;
		const navn = uten.slice(navnStart, i);
		const attributter: Record<string, string> = {};
		for (;;) {
			while (/\s/.test(uten[i])) i++;
			if (uten[i] === '/' || uten[i] === '>') break;
			const aStart = i;
			while (uten[i] !== '=' && !/\s/.test(uten[i])) i++;
			const aNavn = uten.slice(aStart, i);
			while (uten[i] !== '"' && uten[i] !== "'") i++;
			const quote = uten[i++];
			const vStart = i;
			while (uten[i] !== quote) i++;
			attributter[aNavn] = unescape(uten.slice(vStart, i));
			i++;
		}
		if (uten[i] === '/') {
			i += 2;
			return { navn, attributter, barn: [], tekst: '' };
		}
		i++; // '>'
		const barn: ParsedNode[] = [];
		let tekst = '';
		for (;;) {
			const neste = uten.indexOf('<', i);
			if (neste === -1) break;
			tekst += uten.slice(i, neste);
			if (uten[neste + 1] === '/') {
				i = uten.indexOf('>', neste) + 1;
				break;
			}
			i = neste;
			barn.push(parseNode());
		}
		return { navn, attributter, barn, tekst: unescape(tekst).trim() };
	}
	return parseNode();
}

export function finn(node: ParsedNode, sti: string): ParsedNode | undefined {
	const deler = sti.split('/');
	let gjeldende: ParsedNode | undefined = node;
	for (const d of deler) {
		gjeldende = gjeldende?.barn.find((b) => lokaltNavn(b.navn) === d);
		if (!gjeldende) return undefined;
	}
	return gjeldende;
}

export const lokaltNavn = (navn: string): string => navn.split(':').pop() ?? navn;

export function tekstVerdi(node: ParsedNode | undefined, sti: string): string | undefined {
	if (!node) return undefined;
	return finn(node, sti)?.tekst || undefined;
}
