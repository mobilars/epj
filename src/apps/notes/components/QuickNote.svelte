<script lang="ts">
	/**
	 * Writing a note from any tab, in the record's side panel.
	 *
	 * Writing the note is what a consultation actually consists of, and having to
	 * leave the page you are reading in order to write it is the wrong way round.
	 * Posts to the same action as the notes page: there is no second way in.
	 */
	let { patientId }: { patientId: string } = $props();
</script>

<section class="kort">
	<h2>Nytt notat</h2>
	<form method="POST" action="/pasienter/{patientId}/notater?/newValue">
		<div class="felt">
			<label for="hurtig-subjektivt">Subjektivt</label>
			<textarea id="hurtig-subjektivt" name="subjektivt" rows="3"></textarea>
		</div>
		<div class="felt">
			<label for="hurtig-objektivt">Objektivt</label>
			<textarea id="hurtig-objektivt" name="objektivt" rows="3"></textarea>
		</div>
		<div class="felt">
			<label for="hurtig-vurdering">Vurdering og plan</label>
			<textarea id="hurtig-vurdering" name="vurdering" rows="3"></textarea>
		</div>
		<button type="submit" class="primar">Lagre notat</button>
	</form>
</section>
