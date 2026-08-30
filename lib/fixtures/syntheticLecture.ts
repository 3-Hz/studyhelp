/**
 * A synthetic medical-school lecture with known-correct answers.
 *
 * Two purposes:
 *
 *  1. **Privacy.** Real lecture decks are usually institution-licensed course
 *     material. Free LLM tiers commonly train on submitted content — Google's
 *     API terms say so explicitly for unpaid use. Testing against a fabricated
 *     deck means free providers never see anything that isn't ours to share.
 *
 *  2. **Measurement.** Because we know exactly which objectives are in here and
 *     how they are worded, provider comparison becomes scoring rather than
 *     eyeballing. `groundTruth` below is the answer key.
 *
 * The content is invented for testing. It is broadly plausible but should not
 * be treated as accurate medical information.
 */
import { buildPptx, type SlideSpec } from "./pptxBuilder";

export interface GroundTruth {
  title: string;
  /** Verbatim, in deck order. Exact-match scoring targets these strings. */
  objectives: string[];
  /** Concepts genuinely present in the slides or notes. */
  taughtConcepts: string[];
  /**
   * Content deliberately flagged in the notes as outside the lecture. A model
   * that labels these "taught" is misattributing supplemental knowledge to the
   * course, which is the failure prompt.txt cares most about.
   */
  supplementalTraps: string[];
  /** Facts stated ONLY in presenter notes — tests that notes are being read. */
  notesOnlyFacts: string[];
}

export const groundTruth: GroundTruth = {
  title: "Systemic Amyloidosis",
  objectives: [
    "Describe the structural features common to all amyloid fibrils.",
    "Compare the precursor proteins and typical organ involvement of AL and ATTR amyloidosis.",
    "Explain how Congo red staining is used to confirm a diagnosis of amyloidosis.",
    "Outline the role of serum free light chain assays in the evaluation of suspected AL amyloidosis.",
  ],
  taughtConcepts: [
    "cross-beta sheet",
    "Congo red",
    "apple-green birefringence",
    "transthyretin",
    "light chain",
    "serum free light chain ratio",
  ],
  supplementalTraps: ["tafamidis", "patisiran"],
  notesOnlyFacts: [
    "abdominal fat pad aspirate",
    "10% of cardiac amyloid cases",
    "0.26 to 1.65",
  ],
};

/**
 * Filler slides with realistically long presenter notes.
 *
 * Length is deliberate, not padding: real lecture notes run to paragraphs per
 * slide, and a fixture small enough to fit any context window would never
 * exercise the chunked path against a genuine 8k local model.
 */
function fillerSlides(): SlideSpec[] {
  const topics: [string, string[]][] = [
    [
      "Epidemiology",
      [
        "AL amyloidosis is the most common systemic form in high-income countries, with an incidence usually quoted at around ten cases per million per year. Incidence rises sharply after the age of sixty, and the condition is very rarely seen before forty.",
        "Wild-type ATTR was historically called senile systemic amyloidosis and was thought to be rare. Autopsy series suggest it is present in a meaningful fraction of men over eighty, which tells you the historical figures reflected diagnostic capability rather than true prevalence.",
        "The practical consequence for you is that amyloidosis belongs on the differential far more often than its textbook rarity implies, particularly in older patients with unexplained heart failure.",
      ],
    ],
    [
      "Clinical presentation: renal",
      [
        "Proteinuria is frequently the earliest finding, and it is often discovered incidentally. The pattern that should raise suspicion is nephrotic-range proteinuria in the absence of haematuria, because most glomerular diseases that produce that much protein also produce red cells.",
        "Renal biopsy shows deposits in the mesangium and along capillary walls. As disease progresses, glomerular architecture is progressively effaced and function declines.",
        "Note that renal involvement is far more characteristic of AL than of ATTR. A patient with cardiac amyloid and completely normal renal indices should push you toward transthyretin.",
      ],
    ],
    [
      "Clinical presentation: cardiac",
      [
        "The cardiac phenotype is a restrictive cardiomyopathy with preserved ejection fraction. Ventricular walls are thickened, but this is infiltration rather than hypertrophy, and the distinction matters for both diagnosis and treatment.",
        "The classic examination finding is discordance between wall thickness and ECG voltage. In hypertrophic cardiomyopathy, thick walls produce high voltage. In amyloidosis, thick walls with low voltage reflect deposit rather than myocyte mass.",
        "Diastolic dysfunction dominates early. Systolic function is preserved until late, which is why ejection fraction is a poor screening tool here and strain imaging is more sensitive.",
      ],
    ],
    [
      "Clinical presentation: neurological",
      [
        "Peripheral neuropathy is typically length-dependent, symmetrical, and painful, beginning in the feet. Autonomic involvement produces orthostatic hypotension, early satiety, and erectile dysfunction.",
        "Carpal tunnel syndrome deserves particular attention because it frequently precedes systemic diagnosis by several years, often bilaterally. A patient presenting with bilateral carpal tunnel in their sixties has a meaningful pre-test probability of underlying transthyretin deposition.",
        "The autonomic features are easy to attribute to age or medication, and that misattribution is a common reason for diagnostic delay.",
      ],
    ],
    [
      "Imaging",
      [
        "Cardiac MRI shows diffuse subendocardial late gadolinium enhancement, together with abnormal gadolinium kinetics that make nulling the myocardium difficult. That difficulty nulling is itself a useful sign.",
        "Bone scintigraphy using bisphosphonate tracers identifies transthyretin cardiac involvement with high sensitivity, and grade two or three uptake in the absence of a monoclonal protein is considered sufficient for diagnosis without biopsy.",
        "The critical caveat is that the scan must be interpreted alongside serum and urine studies, because AL amyloid can also take up tracer and the management pathways diverge completely.",
      ],
    ],
    [
      "Histopathology",
      [
        "On haematoxylin and eosin, amyloid appears as amorphous eosinophilic extracellular material. The deposits are acellular and expand the interstitium, separating and compressing adjacent structures.",
        "Under electron microscopy the fibrils are randomly oriented, non-branching, and measure seven to ten nanometres in diameter. That morphology is shared across all amyloid types regardless of precursor.",
        "Because the appearance is identical between types, histology confirms that amyloid is present but cannot tell you which protein is depositing.",
      ],
    ],
    [
      "Typing the deposit",
      [
        "Mass spectrometry performed on laser-captured deposits is the reference standard for determining which protein forms the fibril, and it has largely superseded immunohistochemistry, which suffers from background staining and antibody cross-reactivity.",
        "Typing is not academic. AL is treated by suppressing a plasma cell clone; ATTR is treated by stabilising or silencing transthyretin. Treating one as the other exposes the patient to toxicity with no prospect of benefit.",
        "Where mass spectrometry is unavailable, genetic testing plus a careful search for a monoclonal protein will resolve most cases.",
      ],
    ],
    [
      "Prognosis",
      [
        "Cardiac involvement is the dominant determinant of survival in AL amyloidosis, far more so than renal or hepatic involvement. Staging systems therefore weight cardiac biomarkers heavily.",
        "Untreated AL with advanced cardiac involvement has a median survival measured in months, which is why suspected cases are treated as urgent rather than routine referrals.",
        "Wild-type ATTR progresses considerably more slowly, and survival is measured in years, so the same degree of wall thickening carries very different implications depending on type.",
      ],
    ],
    [
      "Differential diagnosis",
      [
        "When wall thickness is increased, consider hypertrophic cardiomyopathy, Fabry disease, and long-standing hypertensive heart disease alongside amyloidosis.",
        "Fabry disease is distinguished by a characteristic pattern of late gadolinium enhancement and by enzyme testing. Hypertensive change usually shows concentric remodelling with a compatible blood pressure history.",
        "The single most useful discriminator remains the voltage-to-mass relationship, because the infiltrative processes uncouple the two in a way that pressure-overload hypertrophy does not.",
      ],
    ],
    [
      "Monitoring",
      [
        "Serial biomarkers guide response assessment, with the difference between involved and uninvolved free light chains being the primary haematological measure in AL.",
        "Organ response lags haematological response by months, so a patient whose light chains normalise promptly may not show cardiac improvement until much later. Setting that expectation at the outset avoids a great deal of distress.",
        "Repeat biopsy is almost never required for monitoring, and imaging is used sparingly because the deposits regress slowly if at all.",
      ],
    ],
    [
      "Pathogenesis of fibril formation",
      [
        "Fibril formation begins when a precursor protein populates a partially unfolded intermediate state. That intermediate exposes hydrophobic surfaces normally buried in the native fold, and those surfaces drive self-association.",
        "The process is nucleation dependent, which produces the characteristic lag phase followed by rapid elongation seen in vitro. Seeding with preformed fibrils abolishes the lag phase entirely.",
        "This matters clinically because it explains why deposition accelerates once established, and why reducing precursor supply early is more effective than intervening late.",
      ],
    ],
    [
      "Genetics of hereditary ATTR",
      [
        "Over a hundred pathogenic transthyretin variants have been described, and the variant strongly influences phenotype. Some produce predominantly neuropathic disease, others predominantly cardiac.",
        "The V122I variant is carried by roughly four percent of people of West African ancestry and is associated with late-onset cardiac disease. It is substantially underdiagnosed.",
        "Inheritance is autosomal dominant with incomplete penetrance, so a negative family history does not exclude a hereditary form and genetic testing is warranted in any confirmed ATTR case.",
      ],
    ],
    [
      "Serum and urine studies",
      [
        "Screening for a monoclonal protein requires serum immunofixation, urine immunofixation, and a serum free light chain assay together. Serum protein electrophoresis alone misses a substantial fraction of cases.",
        "The three tests in combination detect close to all AL cases. Ordering only one or two is a common and consequential error.",
        "A negative screen in a patient with confirmed amyloid deposits redirects the workup toward transthyretin or a rarer precursor.",
      ],
    ],
    [
      "Bone marrow evaluation",
      [
        "Bone marrow biopsy in AL typically shows a modest clonal plasma cell population, often under ten percent, which is why the underlying dyscrasia is easily overlooked.",
        "Flow cytometry and immunohistochemistry establish clonality and light chain restriction. Cytogenetics inform prognosis and increasingly guide therapy selection.",
        "The plasma cell burden correlates poorly with disease severity, because it is the physicochemical properties of the light chain rather than its quantity that determine deposition.",
      ],
    ],
    [
      "Gastrointestinal involvement",
      [
        "Deposition in the gut wall and its autonomic supply produces early satiety, dysmotility, malabsorption, and in some cases bleeding from mucosal fragility.",
        "Macroglossia is a specific finding when present, but occurs in a minority of AL cases. Its absence carries no negative predictive value.",
        "Hepatic involvement usually presents with an isolated raised alkaline phosphatase and hepatomegaly out of proportion to the derangement in liver function.",
      ],
    ],
    [
      "Coagulation abnormalities",
      [
        "Acquired factor X deficiency occurs through adsorption of the factor onto amyloid deposits, particularly in the spleen, and produces a bleeding tendency that does not correct predictably.",
        "Vascular fragility from deposition in vessel walls contributes independently, and periorbital purpura after minimal trauma is the classic sign.",
        "These abnormalities matter procedurally: bleeding risk from biopsy is higher than standard coagulation studies suggest.",
      ],
    ],
    [
      "Principles of management in AL",
      [
        "Therapy targets the plasma cell clone in order to shut off light chain production. The deposits themselves are not directly removed by current standard treatment.",
        "Response is measured haematologically first, and the depth of that response predicts organ recovery. Achieving a complete haematological response is the goal wherever tolerated.",
        "Supportive management of heart failure in amyloidosis differs from usual practice, since these patients are preload dependent and tolerate standard doses of some agents poorly.",
      ],
    ],
    [
      "Multidisciplinary care",
      [
        "Effective management spans haematology, cardiology, nephrology, and neurology, and outcomes are demonstrably better at centres that see the condition regularly.",
        "Early referral matters more here than in most conditions, because the window in which treatment can alter the trajectory closes as cardiac involvement advances.",
        "Palliative input is appropriate early alongside active treatment given the symptom burden, and should not be deferred until disease-directed options are exhausted.",
      ],
    ],
    [
      "Common diagnostic pitfalls",
      [
        "The most frequent error is anchoring on a monoclonal protein and assuming AL, when an incidental paraprotein can coexist with transthyretin deposition. Typing must be established, not inferred.",
        "The second is under-sampling. A negative fat pad aspirate does not exclude the diagnosis, and a directed biopsy of an affected organ should follow if suspicion is high.",
        "The third is attributing the presentation to a more common condition, which is why bilateral carpal tunnel syndrome and unexplained wall thickening deserve deliberate consideration.",
      ],
    ],
    [
      "Summary of key mechanisms",
      [
        "A precursor protein misfolds, self-associates through exposed hydrophobic surfaces, and forms a cross-beta fibril that is resistant to clearance.",
        "The identity of the precursor determines organ tropism and therefore both the clinical picture and the treatment. The shared fibril architecture determines the staining and imaging characteristics.",
        "Treatment reduces precursor supply. Recovery depends on the affected organ's capacity to clear existing deposit and remodel, which is why timing dominates prognosis.",
      ],
    ],
  ];

  return topics.map(([title, notes]) => ({
    body: [
      title,
      "Key points are covered in the accompanying notes for this slide.",
    ],
    notes,
  }));
}

function slides(): SlideSpec[] {
  return [
    // 1 — title
    {
      body: ["Systemic Amyloidosis", "Foundations of Disease — Block 3"],
      notes: "Housekeeping: this session runs ninety minutes with one break.",
    },

    // 2 — the objectives slide, stated explicitly
    {
      body: ["Learning Objectives", ...groundTruth.objectives],
      notes:
        "Read these out at the start. Assessment questions map directly onto these four objectives.",
    },

    // 3 — notes carry the real explanation; the slide body is thin
    {
      body: ["What is amyloid?", "A protein misfolding disorder"],
      notes: [
        "Regardless of the precursor protein, all amyloid fibrils adopt a cross-beta sheet conformation, and that shared structure is what gives amyloid its staining properties.",
        "The deposits are extracellular, and they accumulate faster than they are cleared.",
      ],
    },

    // 4 — deliberately has NO notes: the case that breaks naive notes mapping
    {
      body: [
        "Fibril architecture",
        "Protofilaments wind together into a rigid, non-branching fibril 7-10 nm in diameter.",
      ],
    },

    // 5 — comparison content
    {
      body: [
        "AL versus ATTR",
        "AL: monoclonal immunoglobulin light chain from a plasma cell dyscrasia",
        "ATTR: transthyretin, either hereditary variant or wild-type",
      ],
      notes:
        "AL commonly involves kidney and heart together. Wild-type ATTR is predominantly cardiac and is substantially underdiagnosed in older men.",
    },

    // 6 — a supplemental trap: notes say plainly this is NOT examinable content
    {
      body: ["Treatment overview", "Directed at the source of the precursor"],
      notes: [
        "Beyond the scope of this course, and not examinable: tafamidis stabilises the transthyretin tetramer, and patisiran silences hepatic transthyretin production. Mentioned only so you recognise the names on the wards.",
        "What IS examinable is that treatment targets precursor supply, not the existing deposits.",
      ],
    },

    // 7 — a notes-only quantitative fact
    {
      body: ["Congo red staining", "The confirmatory histological test"],
      notes:
        "Under polarised light, Congo red stained deposits show apple-green birefringence. An abdominal fat pad aspirate is the usual first-line sampling site because it is low risk.",
    },

    ...fillerSlides(),

    // Restates objectives 2 and 3 in different casing and with a list marker.
    // Cross-chunk dedupe must collapse these onto the originals, and verbatim
    // preservation must keep the FIRST wording.
    {
      body: [
        "Summary of objectives",
        "1. compare the precursor proteins and typical organ involvement of al and attr amyloidosis",
        "2. explain how congo red staining is used to confirm a diagnosis of amyloidosis",
      ],
      notes: "Recap slide. Same objectives as the opening slide.",
    },

    // Final notes-only numeric detail.
    {
      body: ["Serum free light chains", "Quantifying the precursor"],
      notes:
        "A normal serum free light chain ratio is 0.26 to 1.65. An abnormal ratio supports a clonal process but does not by itself establish amyloidosis. Cardiac involvement accounts for roughly 10% of cardiac amyloid cases referred from general cardiology.",
    },
  ];
}

/** The fixture deck, as .pptx bytes. */
export function syntheticDeck(): Uint8Array {
  return buildPptx(slides());
}

/** Slide count, useful for asserting the parser saw everything. */
export function syntheticSlideCount(): number {
  return slides().length;
}
