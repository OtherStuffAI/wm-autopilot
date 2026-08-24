const HERO_QUOTE_VARIATIONS = [
  {
    attribution: "Sun Tzu, dawn war-room edition.",
    quote: '"You can just do things. Wingman handles the siege ladders while I nod wisely."',
  },
  {
    attribution: "Benjamin Franklin, kite-laboratory shift.",
    quote: '"You can just do things. Once Wingman showed up, lightning experiments felt like errands."',
  },
  {
    attribution: "Nelson Mandela, reconciliation desk duty.",
    quote: '"You can just do things. Wingman wrangles the chaos so liberation stays focused."',
  },
  {
    attribution: "Jesus of Madeira, boat-building sabbatical.",
    quote: '"You can just do things. Wingman turns water into workflow so I can coast across meetings."',
  },
  {
    attribution: "Thomas Jefferson, midnight drafting sprint.",
    quote: '"You can just do things. Wingman drafted the errands so I could draft a constitution."',
  },
  {
    attribution: "Nikola Tesla, Colorado Springs night shift.",
    quote: '"You can just do things. Wingman spun up the coils so I could chase lightning."',
  },
  {
    attribution: "Commander Kelly’s ISS barista, orbit 42.",
    quote: '"You can just do things. Wingman schedules every orbital latte so zero-G mornings stay calm."',
  },
  {
    attribution: "Kayla, top-left mechanical keyboard key.",
    quote: '"You can just do things. Wingman handles the macros; I just clack dramatically."',
  },
  {
    attribution: "Councilor Whiskers III, alley-cat diplomat.",
    quote: '"You can just do things. Wingman automated the treat rota so we reclaimed nine naps a day."',
  },
  {
    attribution: "Sir Toastwell, sentient toaster laureate.",
    quote: '"You can just do things. Wingman tracks crumb audits so we vibe on medium-brown perfection."',
  },
  {
    attribution: "Amani, time-traveling librarian.",
    quote: '"You can just do things. Wingman files the paradox slips so I can reopen the future stacks."',
  },
  {
    attribution: "Marisol, haunted Roomba whisperer.",
    quote: '"You can just do things. Wingman chases the poltergeist tickets; I sip tea."',
  },
  {
    attribution: "DJ Subsonic Sam, tunnel residency year two.",
    quote: '"You can just do things. Wingman secures permits and power so I just drop beats underground."',
  },
  {
    attribution: "Cirrus, freelance cloud stylist.",
    quote: '"You can just do things. Wingman books every sky fitting; I fluff the cumulus."',
  },
  {
    attribution: "Blackbeard, early career development plan.",
    quote: '"You can just do things. Wingman automated plank waivers so morale finally improved."',
  },
  {
    attribution: "Coach Lila, competitive ferret league.",
    quote: '"You can just do things. Wingman tracks harness inventory so I can coach sprint drills."',
  },
  {
    attribution: "Dr. Sato, lunar bonsai caretaker.",
    quote: '"You can just do things. Wingman times every microgravity watering so I just prune zenfully."',
  },
  {
    attribution: "Professor Mythos, dragon-cover band manager.",
    quote: '"You can just do things. Wingman books the caves so the wyverns focus on rehearsals."',
  },
  {
    attribution: "Ranger Zed, Martian dust-storm wedding planner.",
    quote: '"You can just do things. Wingman coordinates the domes so I perfect the vows."',
  },
  {
    attribution: "Helena Flux, retro arcade historian.",
    quote: '"You can just do things. Wingman restores the cabinets; I curate the quarters."',
  },
];

const pickRandomHeroQuote = () => {
  if (HERO_QUOTE_VARIATIONS.length === 0) {
    return {
      attribution: "Someone insightful. Probably.",
      quote: '"You can just do things. Wingman quietly keeps it all moving."',
    };
  }
  const index = Math.floor(Math.random() * HERO_QUOTE_VARIATIONS.length);
  return HERO_QUOTE_VARIATIONS[index];
};

const createHeroBrand = () => {
  const brand = document.createElement("div");
  brand.className = "wm-home-guest-hero-brand";

  const logoWrapper = document.createElement("div");
  logoWrapper.className = "wm-home-guest-hero-logo-set";

  const logoDark = document.createElement("img");
  logoDark.src = "/path/Wingman_Goose_Logo_Dark.png";
  logoDark.alt = "Wingman logo";
  logoDark.width = 40;
  logoDark.height = 40;
  logoDark.className = "wm-logo dark";

  const logoLight = document.createElement("img");
  logoLight.src = "/path/Wingman_Goose_Logo_Light.png";
  logoLight.alt = "Wingman logo";
  logoLight.width = 40;
  logoLight.height = 40;
  logoLight.className = "wm-logo light";

  logoWrapper.append(logoDark, logoLight);

  const brandCopy = document.createElement("div");
  brandCopy.className = "wm-home-guest-hero-brand-text";

  const brandName = document.createElement("span");
  brandName.className = "wm-home-guest-hero-brand-name";
  brandName.textContent = "Wingman";

  const brandTagline = document.createElement("span");
  brandTagline.className = "wm-home-guest-hero-brand-tagline";
  brandTagline.textContent = "Solvitur Ambulando";

  brandCopy.append(brandName, brandTagline);
  brand.append(logoWrapper, brandCopy);

  return brand;
};

const createHeroActions = ({ onLogin }) => {
  const actions = document.createElement("div");
  actions.className = "wm-home-guest-hero-actions";

  const loginButton = document.createElement("button");
  loginButton.type = "button";
  loginButton.className = "wm-button";
  loginButton.textContent = "Log In to Wingman";
  if (typeof onLogin === "function") {
    loginButton.addEventListener("click", () => {
      onLogin();
    });
  }

  actions.append(loginButton);
  return actions;
};

export function createHomeGuestHero({ onLogin, onBrowse } = {}) {
  const card = document.createElement("section");
  card.className = "wm-card wm-home-guest-hero";

  const quote = document.createElement("blockquote");
  quote.className = "wm-home-guest-hero-quote";

  const quoteText = document.createElement("p");
  quoteText.className = "wm-home-guest-hero-quote-text";

  const { attribution: attributionText, quote: quoteLine } = pickRandomHeroQuote();
  quoteText.textContent = quoteLine;

  quote.append(quoteText);

  const attributionEl = document.createElement("cite");
  attributionEl.className = "wm-home-guest-hero-attribution";
  attributionEl.textContent = `- ${attributionText}`;

  const actions = createHeroActions({ onLogin });

  card.append(quote, attributionEl, actions);
  return card;
}
