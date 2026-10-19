"use strict";

/* ==========================================================
   Tournamake - logique de l'application

   Sommaire :
   1. Constantes
   2. État de l'application et sauvegarde
   3. Outils généraux
   4. Logique du tournoi (tableau, vainqueurs, scores)
   5. Affichage : écrans, tableau, fenêtres
   6. Actions (clics, formulaires)
   7. Export / import
   8. Thème, notifications, démarrage
   ========================================================== */
/* ---------- 1. Constantes ---------- */

const STORAGE_KEY = "tournamake-v1"; // clé conservée pour retrouver les tournois déjà enregistrés
const THEME_KEY = "tournamake-theme";

const MAX_PLAYERS = 32;
const MAX_TOURNAMENT_NAME_LENGTH = 60;
const MAX_PLAYER_NAME_LENGTH = 30;
const MAX_SCORE = 999;
const MAX_IMPORT_FILE_SIZE = 2000000; // octets
const BRACKET_SIZES = [2, 4, 8, 16, 32];

// Dimensions utilisées pour calculer l'agrandissement du tableau (doivent suivre style.css)
const CARD_WIDTH = 190;
const COLUMN_GAP = 48;

const TOAST_DURATION = 3500; // ms
const CONFETTI_COLORS = ["#f5b301", "#5b5bf0", "#ee5fa7", "#1f9d55", "#ff7a45"];

/* ---------- 2. État de l'application et sauvegarde ----------

   state = {
     phase:   "name" | "players" | "bracket"   écran affiché
     name:    nom du tournoi
     players: liste des noms, dans l'ordre saisi
     slots:   places du 1er tour (nom ou null pour "exempt"), deux places consécutives = un match
     choices: choices[tour][match] = "a" | "b" | null   vainqueur désigné ("a" = joueur du haut)
     scores:  scores[tour][match]  = [pointsA, pointsB] | null
     live:    match ouvert dans la fenêtre de score : { round, index, draft? } | null
   }
*/

let state = loadState();

// Variables d'interface (non sauvegardées)
let openDialog = null; // fenêtre ouverte : "start", "redraw", "reset", "import", "import-menu",
// "import-error", "paste", "export-manual"
let pendingImport = null; // tournoi importé en attente de confirmation
let importMessage = ""; // message d'erreur d'import
let manualExport = { text: "", filename: "", reason: "" };
let focusSelector = null; // élément à refocaliser après un nouvel affichage
let toastTimer = null;

function createEmptyState() {
	return {
		phase: "name",
		name: "",
		players: [],
		slots: [],
		choices: [],
		scores: [],
		live: null,
	};
}

function loadState() {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
		if (saved) return migrateState(saved);
	} catch (error) {
		// stockage indisponible ou données illisibles : on repart de zéro
	}
	return createEmptyState();
}

// Les premières versions utilisaient les champs ch, sc et live.{r,m,d}
function migrateState(saved) {
	const migrated = { ...createEmptyState(), ...saved };
	migrated.choices = saved.choices || saved.ch || [];
	migrated.scores = saved.scores || saved.sc || [];
	if (migrated.phase === "bracket" && migrated.scores.length === 0) {
		migrated.scores = migrated.choices.map((round) => round.map(() => null));
	}
	if (saved.live && saved.live.r !== undefined) {
		migrated.live = {
			round: saved.live.r,
			index: saved.live.m,
			draft: saved.live.d,
		};
	}
	delete migrated.ch;
	delete migrated.sc;
	delete migrated.N;
	return migrated;
}

function saveState() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch (error) {
		// stockage indisponible : l'application fonctionne mais ne mémorise rien
	}
}

function saveAndRender() {
	saveState();
	render();
}

/* ---------- 3. Outils généraux ---------- */

function byId(id) {
	return document.getElementById(id);
}

function escapeHtml(text) {
	const replacements = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
	};
	return String(text).replace(
		/[&<>"]/g,
		(character) => replacements[character],
	);
}

// Mélange une liste sur place (algorithme de Fisher-Yates)
function shuffle(list) {
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[list[i], list[j]] = [list[j], list[i]];
	}
}

// Couleur stable pour un nom donné (même nom = même couleur)
function avatarColor(name) {
	let hue = 0;
	for (let i = 0; i < name.length; i++) {
		hue = (hue * 31 + name.charCodeAt(i)) % 360;
	}
	return `hsl(${hue} 65% 42%)`;
}

function avatarHtml(name) {
	const initial = escapeHtml(name.trim().charAt(0).toUpperCase());
	return `<span class="avatar" style="background:${avatarColor(name)}">${initial}</span>`;
}

function otherSide(side) {
	return side === "a" ? "b" : "a";
}

// "Coupe du Vendredi !" -> "coupe-du-vendredi"
function slugify(text) {
	const slug = String(text || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug || "tournoi";
}

// "2026-10-18_14h32"
function timestamp() {
	const now = new Date();
	const two = (number) => String(number).padStart(2, "0");
	return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}h${two(now.getMinutes())}`;
}

/* ---------- 4. Logique du tournoi ---------- */

function roundCount() {
	return Math.log2(state.slots.length);
}

// Construit les places du premier tour à partir de la liste des joueurs.
// Les joueurs s'affrontent deux par deux dans l'ordre de la liste ; si leur nombre
// n'est pas une puissance de 2, les derniers de la liste sont exemptés du 1er tour.
function createBracket() {
	const playerCount = state.players.length;
	let size = 2;
	while (size < playerCount) size *= 2;

	const pairedPlayers = 2 * (playerCount - size / 2);
	const slots = new Array(size).fill(null);
	state.players.forEach((player, i) => {
		const slotIndex =
			i < pairedPlayers ? i : pairedPlayers + 2 * (i - pairedPlayers);
		slots[slotIndex] = player;
	});

	state.slots = slots;
	state.choices = [];
	state.scores = [];
	state.live = null;
	for (let round = 0; round < Math.log2(size); round++) {
		const matchCount = size / 2 ** (round + 1);
		state.choices.push(new Array(matchCount).fill(null));
		state.scores.push(new Array(matchCount).fill(null));
	}
}

// Calcule les matchs de chaque tour : rounds[tour][match] =
//   { playerA, playerB, winner: "a" | "b" | null, isFirstRound }
function computeMatches() {
	const rounds = [];
	for (let round = 0; round < roundCount(); round++) {
		rounds.push([]);
		for (let index = 0; index < state.choices[round].length; index++) {
			let playerA, playerB;
			let winner = null;
			let hasBye = false;

			if (round === 0) {
				playerA = state.slots[2 * index];
				playerB = state.slots[2 * index + 1];
				if (playerA && !playerB) {
					winner = "a";
					hasBye = true;
				}
				if (playerB && !playerA) {
					winner = "b";
					hasBye = true;
				}
			} else {
				playerA = getWinnerName(rounds[round - 1][2 * index]);
				playerB = getWinnerName(rounds[round - 1][2 * index + 1]);
			}

			if (!hasBye && playerA && playerB) winner = state.choices[round][index];
			rounds[round].push({
				playerA,
				playerB,
				winner,
				isFirstRound: round === 0,
			});
		}
	}
	return rounds;
}

function getWinnerName(match) {
	if (!match.winner) return null;
	return match.winner === "a" ? match.playerA : match.playerB;
}

function getChampion() {
	const rounds = computeMatches();
	return getWinnerName(rounds[rounds.length - 1][0]);
}

function hasResults() {
	return state.choices.some((round) => round.some(Boolean));
}

// Quand un résultat change, les tours suivants qui en dépendaient sont remis à zéro
function clearLaterRounds(round, index) {
	if (round + 1 >= state.choices.length) return;
	const nextIndex = Math.floor(index / 2);
	state.choices[round + 1][nextIndex] = null;
	state.scores[round + 1][nextIndex] = null;
	clearLaterRounds(round + 1, nextIndex);
}

// Un score où le vainqueur désigné a moins de points que son adversaire est incohérent : on l'efface
function dropScoreIfContradicting(round, index) {
	const score = state.scores[round][index];
	const winner = state.choices[round][index];
	if (!score || !winner || score[0] === score[1]) return;
	const winnerPoints = score[winner === "a" ? 0 : 1];
	const loserPoints = score[winner === "a" ? 1 : 0];
	if (winnerPoints < loserPoints) state.scores[round][index] = null;
}

// Désigne un vainqueur ou un perdant ; un second clic sur le même bouton annule le choix
function setResult(round, index, side, result) {
	const wantedWinner = result === "win" ? side : otherSide(side);
	const hadChampion = Boolean(getChampion());

	const current = state.choices[round][index];
	state.choices[round][index] = current === wantedWinner ? null : wantedWinner;
	dropScoreIfContradicting(round, index);
	clearLaterRounds(round, index);

	saveAndRender();
	if (!hadChampion && getChampion()) launchConfetti();
}

// Agrandissement du tableau : plus grand quand il y a peu de joueurs, jamais sous la taille normale
function computeScale() {
	const rounds = roundCount();
	const size = state.slots.length;
	const maxScale = size <= 2 ? 1.5 : size <= 4 ? 1.4 : size <= 8 ? 1.2 : 1;
	const availableWidth = Math.max(
		300,
		document.documentElement.clientWidth - 40,
	);
	const naturalWidth =
		(rounds === 1
			? CARD_WIDTH
			: (2 * rounds - 1) * CARD_WIDTH + (2 * rounds - 2) * COLUMN_GAP) + 48;
	return Math.max(1, Math.min(maxScale, availableWidth / naturalWidth));
}

// Nom d'un tour d'après le nombre de matchs qu'il contient
function roundTitle(matchCount) {
	const titles = {
		2: "Demi-finales",
		4: "Quarts de finale",
		8: "Huitièmes",
		16: "Seizièmes",
	};
	return titles[matchCount] || "Finale";
}

// Nom d'un match, au singulier
function matchTitle(matchCount) {
	const titles = {
		1: "Finale",
		2: "Demi-finale",
		4: "Quart de finale",
		8: "Huitième de finale",
	};
	return titles[matchCount] || "Seizième de finale";
}

/* ---------- 5. Affichage ---------- */

function render() {
	const app = byId("app");

	// On retient la position de défilement pour la retrouver après le nouvel affichage
	const previousScrollY = window.scrollY;
	const previousBracketScroll = document.querySelector(".bracket-scroll");
	const previousScrollLeft = previousBracketScroll
		? previousBracketScroll.scrollLeft
		: 0;

	let html;
	if (state.phase === "name") {
		html = renderNameScreen();
	} else if (state.phase === "players") {
		html = renderPlayersScreen();
	} else {
		const rounds = computeMatches();
		html = renderBracketScreen(rounds) + renderLiveDialog(rounds);
	}
	app.innerHTML = html + renderDialog();

	// Tableau : on garde le défilement, ou on le centre à la première ouverture
	const bracketScroll = document.querySelector(".bracket-scroll");
	if (bracketScroll) {
		bracketScroll.scrollLeft = previousBracketScroll
			? previousScrollLeft
			: Math.max(
					0,
					(bracketScroll.scrollWidth - bracketScroll.clientWidth) / 2,
				);
	}
	if (focusSelector) {
		const element = app.querySelector(focusSelector);
		if (element) element.focus({ preventScroll: true });
	}
	window.scrollTo(0, previousScrollY);

	bindDialog();
	bindActionButtons();
	bindNameScreen();
	bindPlayersScreen();
	bindBracketScreen();
}

/* --- Écran 1 : nom du tournoi --- */

function renderNameScreen() {
	return `
    <div class="screen screen--center">
      <h1 class="brand">Tournamake</h1>
      <div class="panel">
        <h2>Pour commencer, donne un nom à ton tournoi</h2>
        <input type="text" id="tournament-name-input" maxlength="${MAX_TOURNAMENT_NAME_LENGTH}" placeholder="Ex. : Coupe du vendredi" value="${escapeHtml(state.name)}">
        <button class="btn btn--full" id="continue-btn">Continuer</button>
      </div>
      <button class="btn btn--ghost btn--spaced" data-action="import-menu">Importer un tournoi</button>
    </div>`;
}

/* --- Écran 2 : liste des joueurs --- */

function renderPlayersScreen() {
	const playerCount = state.players.length;
	const isFull = playerCount >= MAX_PLAYERS;

	const playerItems = state.players
		.map(
			(player, index) => `
    <li>
      <span class="player-label">${avatarHtml(player)}${escapeHtml(player)}</span>
      <button data-remove="${index}" aria-label="Retirer ${escapeHtml(player)}">✕</button>
    </li>`,
		)
		.join("");

	const playerList = playerItems
		? `<ul class="player-list">${playerItems}</ul>`
		: `<div class="empty">Ajoute au moins 2 joueurs pour lancer le tournoi.</div>`;

	const limitNote = isFull
		? `<p class="limit-note" role="status">Limite atteinte : ${MAX_PLAYERS} joueurs maximum. Retire un joueur pour en ajouter un autre.</p>`
		: "";

	return `
    <div class="screen">
      <div class="topbar">
        <h1>${escapeHtml(state.name)}</h1>
        <div class="row">
          <button class="btn btn--ghost" data-action="export">Exporter</button>
          <button class="btn btn--ghost" data-action="import">Importer</button>
          <button class="btn btn--ghost" id="back-to-name-btn">Changer le nom</button>
        </div>
      </div>
      <div class="players-layout">
        <div>
          <div class="list-header"><h3>Joueurs inscrits (${playerCount} / ${MAX_PLAYERS})</h3></div>
          ${playerList}
        </div>
        <div>
          <br>
          <p class="hint">Le tournoi va bientôt commencer ! (${MAX_PLAYERS} joueurs max).<br>
          Au lancement, tu choisiras si le tableau suit l’ordre de cette liste, ou si les places sont tirées au sort.</p>
          <div class="panel panel--flat">
            <h2>Nom du prochain joueur</h2>
            <div class="row">
              <input type="text" id="player-name-input" maxlength="${MAX_PLAYER_NAME_LENGTH}" placeholder="Nom du joueur"${isFull ? " disabled" : ""}>
              <button class="btn" id="add-player-btn"${isFull ? " disabled" : ""}>Ajouter</button>
            </div>
            ${limitNote}
          </div>
          <button class="btn btn--full" id="start-btn"${playerCount < 2 ? " disabled" : ""}>Lancer le tournoi</button>
        </div>
      </div>
    </div>`;
}

/* --- Écran 3 : tableau --- */

function renderBracketScreen(rounds) {
	const lastRound = rounds.length - 1;
	const finalMatch = rounds[lastRound][0];
	const champion = getWinnerName(finalMatch);
	const hasSides = rounds.length > 1; // avec 2 joueurs il n'y a que la finale

	const scale = computeScale();
	const bracketHeight =
		(Math.max(260, (state.slots.length / 4) * 124) + 100) * scale;

	const playedCount = state.choices.reduce(
		(total, round) => total + round.filter(Boolean).length,
		0,
	);
	const totalMatches = state.players.length - 1;
	const progress = champion
		? "Tournoi terminé"
		: `${playedCount} / ${totalMatches} matchs joués`;

	const championBox = champion
		? `<div class="champion champion--crowned">🏆 ${escapeHtml(champion)}<small>Vainqueur du tournoi</small></div>`
		: `<div class="champion">Vainqueur à venir</div>`;
	const finalLinks = hasSides ? " match--final-left match--final-right" : "";

	return `
    <div class="screen">
      <div class="topbar">
        <h1>${escapeHtml(state.name)}</h1>
        <span class="progress-pill">${progress}</span>
        <div class="row">
          <button class="btn btn--ghost" data-action="export">Exporter</button>
          <button class="btn btn--ghost" data-action="import">Importer</button>
          <button class="btn btn--ghost" id="redraw-btn">Nouveau tirage</button>
          <button class="btn btn--ghost" id="back-to-players-btn">Modifier les joueurs</button>
          <button class="btn btn--ghost" id="new-tournament-btn">Nouveau tournoi</button>
        </div>
      </div>
      <div class="bracket-scroll">
        <div class="bracket" style="--scale:${scale.toFixed(3)};height:${bracketHeight}px">
          ${hasSides ? renderSide(rounds, "left") : ""}
          <div class="final-column${hasSides ? "" : " final-column--alone"}">
            <div class="match match--final${finalLinks}">
              ${championBox}
              ${renderPlayerRow(finalMatch, "a", lastRound, 0)}
              ${renderPlayerRow(finalMatch, "b", lastRound, 0)}
              ${renderLiveButton(finalMatch, lastRound, 0)}
            </div>
          </div>
          ${hasSides ? renderSide(rounds, "right") : ""}
        </div>
      </div>
    </div>`;
}

// Moitié gauche ou droite du tableau (tous les tours sauf la finale)
function renderSide(rounds, side) {
	let columns = "";
	for (let round = 0; round < rounds.length - 1; round++) {
		const matchCount = rounds[round].length;
		const matchesPerSide = matchCount / 2;
		const firstIndex = side === "left" ? 0 : matchesPerSide;

		let slots = "";
		for (let i = 0; i < matchesPerSide; i++) {
			// Les matchs vont par paires : le premier et le second sont reliés par un trait vertical
			const pairClass =
				matchesPerSide > 1
					? i % 2 === 0
						? " slot--top"
						: " slot--bottom"
					: "";
			const linkClass = "match--out" + (round > 0 ? " match--in" : "");
			slots += `<div class="slot${pairClass}">${renderMatch(rounds, round, firstIndex + i, linkClass)}</div>`;
		}
		columns += `<div class="column"><div class="round-label">${roundTitle(matchCount)}</div>${slots}</div>`;
	}
	return `<div class="side side--${side}">${columns}</div>`;
}

function renderMatch(rounds, round, index, linkClass) {
	const match = rounds[round][index];
	return `
    <div class="match ${linkClass}">
      ${renderPlayerRow(match, "a", round, index)}
      ${renderPlayerRow(match, "b", round, index)}
      ${renderLiveButton(match, round, index)}
    </div>`;
}

function renderPlayerRow(match, side, round, index) {
	const name = side === "a" ? match.playerA : match.playerB;
	const opponent = side === "a" ? match.playerB : match.playerA;

	if (!name) {
		const modifier = match.isFirstRound ? "bye" : "waiting";
		const label = match.isFirstRound ? "Exempt" : "En attente";
		return `<div class="player player--${modifier}"><span class="player-name">${label}</span></div>`;
	}

	let statusClass = "";
	if (match.winner)
		statusClass = match.winner === side ? " player--win" : " player--lose";

	const score = state.scores[round][index];
	const scoreHtml = score
		? `<span class="score">${score[side === "a" ? 0 : 1]}</span>`
		: "";

	// Les boutons ✓ / ✕ n'apparaissent que si l'adversaire est connu
	let buttons = "";
	if (opponent) {
		const position = `data-round="${round}" data-index="${index}" data-side="${side}"`;
		const isWinner = match.winner === side;
		const isLoser = Boolean(match.winner) && match.winner !== side;
		buttons = `
      <button class="result-btn result-btn--win${isWinner ? " is-active" : ""}" ${position} data-result="win" title="Vainqueur" aria-label="Désigner ${escapeHtml(name)} vainqueur">✓</button>
      <button class="result-btn result-btn--lose${isLoser ? " is-active" : ""}" ${position} data-result="lose" title="Perdant" aria-label="Désigner ${escapeHtml(name)} perdant">✕</button>`;
	}

	return `<div class="player${statusClass}">${avatarHtml(name)}<span class="player-name">${escapeHtml(name)}</span>${scoreHtml}${buttons}</div>`;
}

// Bouton sous un match : lancer le direct, reprendre le direct, ajouter ou modifier un score
function renderLiveButton(match, round, index) {
	if (!match.playerA || !match.playerB) return "";

	const score = state.scores[round][index];
	const isDecided = Boolean(match.winner);

	let label;
	if (isDecided) {
		label = score ? "✎ Modifier le score" : "+ Ajouter un score";
	} else if (score) {
		label = `<i class="live-dot"></i>En direct ${score[0]} – ${score[1]}`;
	} else {
		label = "▶ Lancer en direct";
	}

	const runningClass = score && !isDecided ? " live-btn--running" : "";
	return `<button class="live-btn${runningClass}" data-live-button data-decided="${isDecided ? 1 : 0}" data-round="${round}" data-index="${index}">${label}</button>`;
}

/* --- Fenêtre de score (match en direct ou modification d'un score) --- */

function renderLiveDialog(rounds) {
	if (!state.live) return "";

	const { round, index } = state.live;
	const match = rounds[round] && rounds[round][index];
	if (!match || !match.playerA || !match.playerB) {
		state.live = null;
		return "";
	}

	// Match déjà terminé : on modifie un brouillon, enregistré seulement avec "Enregistrer"
	const isEditing = Boolean(match.winner);
	if (isEditing && !state.live.draft) {
		state.live.draft = [...(state.scores[round][index] || [0, 0])];
	}
	const score = isEditing
		? state.live.draft
		: state.scores[round][index] || [0, 0];

	const isTie = score[0] === score[1];
	const winnerLeads =
		match.winner === "a" ? score[0] > score[1] : score[1] > score[0];
	const canSave = isEditing && (isTie || winnerLeads);

	const title = `${isEditing ? "Score du match" : `<i class="live-dot"></i>Match en direct`} – ${matchTitle(rounds[round].length)}`;

	let actions;
	if (isEditing) {
		actions = `<button class="btn" id="live-save-btn"${canSave ? "" : " disabled"}>Enregistrer</button>`;
		if (state.scores[round][index]) {
			actions += `<button class="btn btn--ghost" id="live-clear-btn">Supprimer le score</button>`;
		}
	} else {
		actions = `<button class="btn" id="live-end-btn"${isTie ? " disabled" : ""}>Terminer le match</button>`;
	}

	let note;
	if (isEditing) {
		const winnerName = match.winner === "a" ? match.playerA : match.playerB;
		note = canSave
			? "Le vainqueur désigné ne change pas."
			: `Le score doit être cohérent avec le vainqueur désigné (${escapeHtml(winnerName)}) : il ne peut pas avoir moins de points que son adversaire.`;
	} else {
		note = isTie
			? "Égalité : il faut un vainqueur pour terminer le match."
			: "Le joueur avec le plus de points passe au tour suivant.";
	}

	return `
    <div class="overlay" id="live-overlay" role="dialog" aria-modal="true" aria-label="Match en direct">
      <div class="panel dialog-panel">
        <h2>${title}</h2>
        <div class="live-grid">
          ${renderLivePlayer("a", match.playerA, score[0])}
          <span class="vs">vs</span>
          ${renderLivePlayer("b", match.playerB, score[1])}
        </div>
        <div class="dialog-actions">
          ${actions}
          <button class="btn btn--ghost" id="live-close-btn">Fermer</button>
        </div>
        <p class="hint hint--top">${note}</p>
      </div>
    </div>`;
}

function renderLivePlayer(side, name, points) {
	const safeName = escapeHtml(name);
	return `
    <div class="live-player">
      ${avatarHtml(name)}
      <b>${safeName}</b>
      <div class="live-score" aria-live="polite">${points}</div>
      <div class="counter">
        <button data-score-side="${side}" data-delta="-1" aria-label="Retirer un point à ${safeName}">−</button>
        <button class="counter-plus" data-score-side="${side}" data-delta="1" aria-label="Ajouter un point à ${safeName}">+</button>
      </div>
    </div>`;
}

/* --- Fenêtres de confirmation et d'information --- */

function getDialogContent() {
	switch (openDialog) {
		case "start":
			return {
				title: "Comment former le tableau ?",
				message:
					"Suivre l’ordre de la liste : les joueurs s’affrontent deux par deux (1 contre 2, 3 contre 4, etc.). Si le nombre est impair ou n’est pas une puissance de 2, les derniers de la liste sont exemptés du premier tour. Sinon, les places sont tirées au sort.",
				buttons: `<button class="btn" data-dialog-action="order">Suivre l’ordre de la liste</button>
                  <button class="btn" data-dialog-action="shuffle">Tirer au sort</button>`,
			};
		case "import-menu":
			return {
				title: "Importer un tournoi",
				message: "Choisis d’où vient l’export.",
				buttons: `<button class="btn" data-dialog-action="file">Depuis un fichier</button>
                  <button class="btn" data-dialog-action="text">Depuis du texte</button>`,
			};
		case "paste":
			return {
				title: "Importer depuis du texte",
				message: "Colle ici le contenu d’un fichier exporté depuis Tournamake.",
				field: `<textarea id="paste-textarea" class="textarea" aria-label="Contenu à importer"></textarea>`,
				buttons: `<button class="btn" data-dialog-action="import-text">Importer</button>`,
			};
		case "export-manual":
			return {
				title: "Export manuel",
				message: `Le téléchargement direct n’a pas abouti (${escapeHtml(manualExport.reason)}). Copie le contenu ci-dessous et enregistre-le dans un fichier nommé <b>${escapeHtml(manualExport.filename)}</b>. La personne qui le reçoit pourra le coller via « Importer », puis « Depuis du texte ».`,
				field: `<textarea id="export-textarea" class="textarea" readonly>${escapeHtml(manualExport.text)}</textarea>`,
				buttons: `<button class="btn" data-dialog-action="copy">Copier le contenu</button>`,
			};
		case "import":
			return {
				title: "Remplacer le tournoi en cours ?",
				message: `Le tournoi « ${escapeHtml(pendingImport.name)} » va remplacer celui qui est ouvert. Exporte d’abord l’actuel si tu veux le garder.`,
				buttons: `<button class="btn" data-dialog-action="confirm">Importer et remplacer</button>`,
			};
		case "import-error":
			return {
				title: "Import impossible",
				message: escapeHtml(importMessage),
				buttons: "",
			};
		case "redraw":
			return {
				title: "Refaire un tirage ?",
				message:
					"Les places seront tirées au sort et les résultats déjà saisis seront effacés.",
				buttons: `<button class="btn" data-dialog-action="confirm">Refaire le tirage</button>`,
			};
		default: // "reset"
			return {
				title: "Nouveau tournoi ?",
				message: "Le tournoi en cours et tous ses résultats seront effacés.",
				buttons: `<button class="btn" data-dialog-action="confirm">Effacer et recommencer</button>`,
			};
	}
}

function renderDialog() {
	if (!openDialog) return "";
	const content = getDialogContent();
	const closeLabel =
		openDialog === "import-error" || openDialog === "export-manual"
			? "Fermer"
			: "Annuler";
	return `
    <div class="overlay" id="dialog-overlay" role="dialog" aria-modal="true" aria-label="${content.title}">
      <div class="panel dialog-panel">
        <h2>${content.title}</h2>
        <p class="hint">${content.message}</p>
        ${content.field || ""}
        <div class="dialog-actions dialog-actions--column">
          ${content.buttons}
          <button class="btn btn--ghost" data-dialog-action="cancel">${closeLabel}</button>
        </div>
      </div>
    </div>`;
}

/* ---------- 6. Actions ---------- */

/* --- Fenêtres de confirmation --- */

function bindDialog() {
	document.querySelectorAll("[data-dialog-action]").forEach((button) => {
		button.onclick = () => handleDialogAction(button.dataset.dialogAction);
	});

	const overlay = byId("dialog-overlay");
	if (!overlay) return;
	overlay.onclick = (event) => {
		if (event.target === overlay) closeDialog();
	};
	const firstButton = overlay.querySelector(".btn");
	if (firstButton) firstButton.focus({ preventScroll: true });
}

function closeDialog() {
	openDialog = null;
	render();
}

function handleDialogAction(action) {
	// Actions qui gardent ou changent de fenêtre
	if (action === "file") {
		openDialog = null;
		render();
		byId("file-input").click();
		return;
	}
	if (action === "text") {
		openDialog = "paste";
		render();
		return;
	}
	if (action === "copy") {
		copyManualExport();
		return;
	}
	if (action === "import-text") {
		importFromText(byId("paste-textarea").value);
		return;
	}

	// Actions qui ferment la fenêtre
	const dialog = openDialog;
	openDialog = null;
	if (action === "cancel") {
		render();
		return;
	}

	if (dialog === "start") {
		if (action === "shuffle") shuffle(state.players);
		createBracket();
		state.phase = "bracket";
	} else if (dialog === "redraw") {
		shuffle(state.players);
		createBracket();
	} else if (dialog === "reset") {
		state = createEmptyState();
	} else if (dialog === "import" && pendingImport) {
		state = pendingImport;
		pendingImport = null;
		toast("Tournoi importé");
	}
	saveAndRender();
}

/* --- Boutons d'export / import présents sur plusieurs écrans --- */

function bindActionButtons() {
	document.querySelectorAll("[data-action]").forEach((button) => {
		button.onclick = () => {
			const action = button.dataset.action;
			if (action === "export") {
				exportTournament();
			} else if (action === "import-menu") {
				openDialog = "import-menu";
				render();
			} else {
				byId("file-input").click(); // action "import" : directement la sélection de fichier
			}
		};
	});
}

/* --- Écran 1 : nom du tournoi --- */

function bindNameScreen() {
	const input = byId("tournament-name-input");
	if (!input) return;

	input.focus();
	input.onkeydown = (event) => {
		if (event.key === "Enter") byId("continue-btn").click();
	};
	byId("continue-btn").onclick = () => {
		const name = input.value.trim();
		if (!name) {
			input.focus();
			return;
		}
		state.name = name;
		state.phase = "players";
		saveAndRender();
	};
}

/* --- Écran 2 : liste des joueurs --- */

function bindPlayersScreen() {
	const input = byId("player-name-input");
	if (!input) return;

	const addPlayer = () => {
		const name = input.value.trim();
		if (!name || state.players.length >= MAX_PLAYERS) return;
		state.players.push(name);
		saveAndRender();
	};
	byId("add-player-btn").onclick = addPlayer;
	input.onkeydown = (event) => {
		if (event.key === "Enter") addPlayer();
	};
	input.focus();

	byId("back-to-name-btn").onclick = () => {
		state.phase = "name";
		saveAndRender();
	};
	byId("start-btn").onclick = () => {
		openDialog = "start";
		render();
	};
	document.querySelectorAll("[data-remove]").forEach((button) => {
		button.onclick = () => {
			state.players.splice(Number(button.dataset.remove), 1);
			saveAndRender();
		};
	});
}

/* --- Écran 3 : tableau --- */

function bindBracketScreen() {
	if (state.phase !== "bracket") return;

	byId("new-tournament-btn").onclick = () => {
		openDialog = "reset";
		render();
	};
	byId("back-to-players-btn").onclick = () => {
		state.phase = "players";
		state.live = null;
		saveAndRender();
	};
	byId("redraw-btn").onclick = () => {
		if (hasResults()) {
			openDialog = "redraw"; // on demande confirmation car les résultats seraient effacés
		} else {
			shuffle(state.players);
			createBracket();
			saveState();
		}
		render();
	};

	// Boutons ✓ / ✕ à côté des noms
	document.querySelectorAll(".result-btn").forEach((button) => {
		button.onclick = () => {
			const { round, index, side, result } = button.dataset;
			setResult(Number(round), Number(index), side, result);
		};
	});

	// Bouton sous un match : ouvre la fenêtre de score
	document.querySelectorAll("[data-live-button]").forEach((button) => {
		button.onclick = () => {
			const round = Number(button.dataset.round);
			const index = Number(button.dataset.index);
			const isDecided = button.dataset.decided === "1";
			if (!isDecided)
				state.scores[round][index] = state.scores[round][index] || [0, 0];
			state.live = { round, index };
			focusSelector = '[data-score-side="a"][data-delta="1"]';
			saveAndRender();
		};
	});

	bindLiveDialog();
}

function bindLiveDialog() {
	document.querySelectorAll("[data-score-side]").forEach((button) => {
		button.onclick = () =>
			changeLiveScore(button.dataset.scoreSide, Number(button.dataset.delta));
	});

	const overlay = byId("live-overlay");
	if (!overlay) return;
	overlay.onclick = (event) => {
		if (event.target === overlay) closeLiveDialog();
	};
	byId("live-close-btn").onclick = closeLiveDialog;

	const endButton = byId("live-end-btn");
	if (endButton) endButton.onclick = finishLiveMatch;

	const saveButton = byId("live-save-btn");
	if (saveButton) {
		saveButton.onclick = () => {
			const { round, index, draft } = state.live;
			state.scores[round][index] = [...draft];
			closeLiveDialog();
		};
	}

	const clearButton = byId("live-clear-btn");
	if (clearButton) {
		clearButton.onclick = () => {
			const { round, index } = state.live;
			state.scores[round][index] = null;
			closeLiveDialog();
		};
	}
}

function closeLiveDialog() {
	state.live = null;
	focusSelector = null;
	saveAndRender();
}

// Ajoute ou retire un point (en direct : score du match ; en modification : brouillon)
function changeLiveScore(side, delta) {
	const { round, index, draft } = state.live;
	const score = draft || state.scores[round][index];
	const position = side === "a" ? 0 : 1;
	score[position] = Math.max(0, score[position] + delta);
	focusSelector = `[data-score-side="${side}"][data-delta="${delta}"]`;
	saveAndRender();
}

// "Terminer le match" : le joueur avec le plus de points est désigné vainqueur
function finishLiveMatch() {
	const { round, index } = state.live;
	const score = state.scores[round][index];
	const hadChampion = Boolean(getChampion());

	state.choices[round][index] = score[0] > score[1] ? "a" : "b";
	clearLaterRounds(round, index);
	state.live = null;
	focusSelector = null;

	saveAndRender();
	if (!hadChampion && getChampion()) launchConfetti();
}

/* ---------- 7. Export / import ---------- */

function exportTournament() {
	const data = {
		app: "tournamake",
		version: 2,
		exportedAt: new Date().toISOString(),
		tournament: {
			name: state.name,
			phase: state.phase,
			players: state.players,
			slots: state.slots,
			choices: state.choices,
			scores: state.scores,
		},
	};
	const text = JSON.stringify(data, null, 2);
	const filename = `tournamake_${slugify(state.name)}_${timestamp()}.json`;

	try {
		downloadFile(filename, text);
		toast(`Tournoi exporté : ${filename}`);
	} catch (error) {
		// Solution de secours : afficher le contenu pour le copier à la main
		manualExport = { text, filename, reason: "erreur" };
		openDialog = "export-manual";
		render();
	}
}

function downloadFile(filename, text) {
	const url = URL.createObjectURL(
		new Blob([text], { type: "application/json" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.style.display = "none";
	document.body.appendChild(link);
	link.click();
	setTimeout(() => {
		URL.revokeObjectURL(url);
		link.remove();
	}, 1000);
}

function copyManualExport() {
	const textarea = byId("export-textarea");
	let copied = false;
	try {
		textarea.focus();
		textarea.select();
		copied = document.execCommand("copy");
	} catch (error) {
		copied = false;
	}
	if (copied) {
		toast("Contenu copié");
		return;
	}

	const failureMessage = "Copie impossible : sélectionne le texte à la main.";
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(manualExport.text).then(
			() => toast("Contenu copié"),
			() => toast(failureMessage),
		);
	} else {
		toast(failureMessage);
	}
}

// Vérifie le contenu d'un export et renvoie un état prêt à l'emploi.
// Lève une erreur avec un message lisible si le contenu n'est pas valide.
// Accepte aussi les exports de la version 1 (champs ch, sc).
function parseImport(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new Error("Ce fichier n’est pas un JSON valide.");
	}

	const tournament = data && data.app === "tournamake" && data.tournament;
	if (!tournament)
		throw new Error("Ce fichier n’est pas un export Tournamake.");

	const name =
		typeof tournament.name === "string"
			? tournament.name.trim().slice(0, MAX_TOURNAMENT_NAME_LENGTH)
			: "";
	if (!name) throw new Error("Le nom du tournoi est manquant.");

	const rawPlayers = tournament.players;
	const playersAreValid =
		Array.isArray(rawPlayers) &&
		rawPlayers.length <= MAX_PLAYERS &&
		rawPlayers.every((player) => typeof player === "string" && player.trim());
	if (!playersAreValid)
		throw new Error(
			`La liste des joueurs est invalide (${MAX_PLAYERS} maximum).`,
		);
	const players = rawPlayers.map((player) =>
		player.trim().slice(0, MAX_PLAYER_NAME_LENGTH),
	);

	const phase =
		tournament.phase === "bracket" || tournament.phase === "players"
			? tournament.phase
			: "name";
	const imported = { ...createEmptyState(), phase, name, players };
	if (phase !== "bracket") return imported;

	// Tableau : on vérifie que les places, résultats et scores ont la bonne forme
	const rawSlots = tournament.slots;
	const size = Array.isArray(rawSlots) ? rawSlots.length : 0;
	const sizeIsValid =
		BRACKET_SIZES.includes(size) &&
		players.length >= 2 &&
		players.length <= size &&
		players.length > size / 2;
	if (!sizeIsValid) throw new Error("Le tableau est invalide.");

	const slots = rawSlots.map((slot) =>
		slot === null
			? null
			: typeof slot === "string"
				? slot.trim().slice(0, MAX_PLAYER_NAME_LENGTH)
				: undefined,
	);
	const slotsAreValid =
		slots.every(
			(slot) => slot === null || (slot !== undefined && players.includes(slot)),
		) && slots.filter(Boolean).length === players.length;
	if (!slotsAreValid)
		throw new Error("Les places du tableau ne correspondent pas aux joueurs.");

	const rawChoices = tournament.choices || tournament.ch;
	const rawScores = tournament.scores || tournament.sc;
	const roundTotal = Math.log2(size);
	if (!Array.isArray(rawChoices) || rawChoices.length !== roundTotal)
		throw new Error("Les résultats sont invalides.");

	imported.slots = slots;
	for (let round = 0; round < roundTotal; round++) {
		const matchCount = size / 2 ** (round + 1);
		const roundChoices = rawChoices[round];
		const choicesAreValid =
			Array.isArray(roundChoices) &&
			roundChoices.length === matchCount &&
			roundChoices.every(
				(choice) => choice === null || choice === "a" || choice === "b",
			);
		if (!choicesAreValid) throw new Error("Les résultats sont invalides.");

		const roundScores =
			Array.isArray(rawScores) &&
			Array.isArray(rawScores[round]) &&
			rawScores[round].length === matchCount
				? rawScores[round]
				: new Array(matchCount).fill(null);

		imported.choices.push([...roundChoices]);
		imported.scores.push(roundScores.map(sanitizeScore));
	}
	return imported;
}

// Un score valide est une paire d'entiers entre 0 et MAX_SCORE ; sinon on l'ignore
function sanitizeScore(score) {
	const isValid =
		Array.isArray(score) &&
		score.length === 2 &&
		score.every(
			(points) =>
				Number.isInteger(points) && points >= 0 && points <= MAX_SCORE,
		);
	return isValid ? [...score] : null;
}

function importFromText(text) {
	let imported;
	try {
		imported = parseImport(text.trim());
	} catch (error) {
		showImportError(error.message);
		return;
	}

	const hasCurrentTournament = state.name || state.players.length > 0;
	if (hasCurrentTournament) {
		pendingImport = imported; // on demande confirmation avant de remplacer
		openDialog = "import";
		render();
	} else {
		state = imported;
		saveAndRender();
		toast(`Tournoi importé : ${state.name}`);
	}
}

function showImportError(message) {
	importMessage = message;
	openDialog = "import-error";
	render();
}

function importFromFile(file) {
	if (file.size > MAX_IMPORT_FILE_SIZE) {
		showImportError("Ce fichier est trop volumineux.");
		return;
	}
	const reader = new FileReader();
	reader.onload = () => importFromText(String(reader.result));
	reader.onerror = () => showImportError("Impossible de lire ce fichier.");
	reader.readAsText(file);
}

/* ---------- 8. Thème, notifications, démarrage ---------- */

function toast(message) {
	const element = byId("toast");
	element.textContent = message;
	element.classList.add("toast--visible");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(
		() => element.classList.remove("toast--visible"),
		TOAST_DURATION,
	);
}

// Pluie de confettis à l'arrivée d'un vainqueur (désactivée si l'appareil réduit les animations)
function launchConfetti() {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

	const container = document.createElement("div");
	container.style.cssText =
		"position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:30";
	for (let i = 0; i < 60; i++) {
		const piece = document.createElement("i");
		const duration = 1.8 + Math.random() * 1.6;
		const delay = Math.random() * 0.6;
		piece.style.cssText =
			`position:absolute;top:-16px;left:${Math.random() * 100}%;width:8px;height:14px;` +
			`border-radius:2px;background:${CONFETTI_COLORS[i % CONFETTI_COLORS.length]};` +
			`transform:rotate(${Math.random() * 360}deg);animation:confetti-fall ${duration}s ease-in ${delay}s forwards`;
		container.appendChild(piece);
	}
	document.body.appendChild(container);
	setTimeout(() => container.remove(), 4200);
}

/* --- Thème clair / sombre : suit l'appareil tant que l'utilisateur n'a pas choisi --- */

const systemDarkMode = window.matchMedia("(prefers-color-scheme: dark)");

function getSavedTheme() {
	try {
		return localStorage.getItem(THEME_KEY);
	} catch (error) {
		return null;
	}
}

function applyTheme(theme) {
	const isDark = theme === "dark";
	const button = byId("theme-toggle");
	document.documentElement.dataset.theme = theme;
	button.textContent = isDark ? "☀" : "🌙";
	button.title = isDark ? "Passer au thème clair" : "Passer au thème sombre";
	button.setAttribute("aria-label", button.title);
}

function initTheme() {
	applyTheme(getSavedTheme() || (systemDarkMode.matches ? "dark" : "light"));

	byId("theme-toggle").onclick = () => {
		const newTheme =
			document.documentElement.dataset.theme === "dark" ? "light" : "dark";
		try {
			localStorage.setItem(THEME_KEY, newTheme);
		} catch (error) {
			// le choix ne sera pas mémorisé
		}
		applyTheme(newTheme);
	};

	systemDarkMode.addEventListener("change", () => {
		if (!getSavedTheme()) applyTheme(systemDarkMode.matches ? "dark" : "light");
	});
}

/* --- Démarrage --- */

byId("file-input").onchange = (event) => {
	const input = event.target;
	const file = input.files && input.files[0];
	input.value = ""; // permet de choisir plusieurs fois le même fichier
	if (file) importFromFile(file);
};

// Échap ferme la fenêtre ouverte
document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	if (openDialog) closeDialog();
	else if (state.live) closeLiveDialog();
});

// Le tableau est recalculé quand la largeur de l'écran change (rotation du téléphone, redimensionnement)
let lastWidth = window.innerWidth;
let resizeTimer = null;
window.addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => {
		if (window.innerWidth === lastWidth) return;
		lastWidth = window.innerWidth;
		if (state.phase === "bracket" && !openDialog && !state.live) render();
	}, 150);
});

render();
initTheme();
