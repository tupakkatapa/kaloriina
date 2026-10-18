//! Fineli import: the Finnish food composition database by THL, open data
//! under CC BY 4.0 (<https://fineli.fi>).
//!
//! Reads an unzipped Fineli open-data package: `food.csv`,
//! `component_value.csv` and `foodaddunit.csv`, all Latin-1, `;`-separated,
//! with decimal commas. Values are per 100 g of edible portion. Foods are
//! keyed by Fineli's `FOODID`, so importing a newer release updates them in
//! place.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::Path;

use rusqlite::Connection;

use crate::db;
use crate::error::Error;
use crate::model::FoodCategory::{FruitVeg, ProcessedMeat, SugaryDrinks, SweetsSnacks};
use crate::model::{FoodCategory, FoodInput, Serving};
use crate::nutrients::{IU_PER_UG, KJ_PER_KCAL, Nutrients};

/// Fineli component code, registry key, and the factor from Fineli's unit to
/// the registry's.
const COMPONENTS: [(&str, &str, f64); 44] = [
    ("ENERC", "energy", 1.0 / KJ_PER_KCAL),
    ("FAT", "fat", 1.0),
    ("FASAT", "saturated", 1.0),
    ("FAMCIS", "monounsaturated", 1.0),
    ("FAPU", "polyunsaturated", 1.0),
    ("FATRN", "trans_fats", 1.0),
    ("FAPUN3", "omega_3", 1.0),
    ("FAPUN6", "omega_6", 1.0),
    ("F18D2CN6", "la", 0.001),
    ("F18D3N3", "ala", 0.001),
    ("F20D4N6", "aa", 0.001),
    ("F20D5N3", "epa", 0.001),
    ("F22D6N3", "dha", 0.001),
    ("CHOLE", "cholesterol", 1.0),
    // EU "carbohydrate": available carbohydrate, fibre excluded.
    ("CHOAVL", "net_carbs", 1.0),
    ("SUGAR", "sugars", 1.0),
    ("STARCH", "starch", 1.0),
    ("FIBC", "fiber", 1.0),
    ("FIBINS", "insoluble_fiber", 1.0),
    ("PROT", "protein", 1.0),
    ("TRP", "tryptophan", 0.001),
    ("ALC", "alcohol", 1.0),
    ("WATER", "water", 1.0),
    ("NA", "sodium", 1.0),
    ("K", "potassium", 1.0),
    ("CA", "calcium", 1.0),
    ("MG", "magnesium", 1.0),
    ("P", "phosphorus", 1.0),
    ("FE", "iron", 1.0),
    ("ZN", "zinc", 1.0),
    ("CU", "copper", 1.0),
    ("MN", "manganese", 1.0),
    ("SE", "selenium", 1.0),
    // Retinol activity equivalents (RAE), made retinol equivalents (RE) in
    // `parse` with `RETOL`.
    ("VITA", "vitamin_a", 1.0),
    // Stored in IU; 1 µg = 40 IU.
    ("VITD", "vitamin_d", IU_PER_UG),
    ("VITE", "vitamin_e", 1.0),
    ("VITK", "vitamin_k", 1.0),
    ("THIA", "b1", 1.0),
    ("RIBF", "b2", 1.0),
    // Niacin equivalents, the unit EFSA's reference values use.
    ("NIAEQ", "b3", 1.0),
    ("VITPYRID", "b6", 1.0),
    ("FOL", "folate", 1.0),
    ("VITB12", "b12", 1.0),
    ("VITC", "vitamin_c", 1.0),
];

/// Fineli food class → food category, looked up by `FUCLASS` (the
/// food-use class) first, then `IGCLASS` (the ingredient class). Codes are
/// one namespace: a code in both lists means the same in both. A class
/// listed as `None` has no category and ends the lookup, so a mixed dish or
/// a diet drink never takes one from its ingredient class. No Fineli class
/// is fast food: that comes from Open Food Facts or your own choice.
///
/// Filled from the release's class list (`kaloriina fineli --classes <dir>`):
///
/// | Category        | Classes                                                      |
/// |-----------------|--------------------------------------------------------------|
/// | sweets & snacks | sweet bakery, buns, sweet biscuits, cereal bars, chocolate,  |
/// |                 | confectionery, ice cream, milk desserts, dessert sauces,     |
/// |                 | jams, sugar and syrups, savoury snacks                       |
/// | sugary drinks   | soft drinks with sugar or caffeine, juice drinks, juices,    |
/// |                 | sport drinks                                                 |
/// | fruit & veg     | fresh, cooked and canned vegetables, fruits, berries, canned |
/// |                 | fruit, vegetable and fruit salads, pulses, edible fungi,     |
/// |                 | dried herbs, baby fruit and vegetable products               |
/// | processed meat  | sausages, cold cuts (sausage and meat), meat products        |
/// | none (stops)    | alcohol, artificially sweetened drinks, water, vegetable     |
/// |                 | juices; every dish, soup and sauce class                     |
///
/// Unlisted, so only the ingredient class can give one: bread, breakfast
/// cereals, porridge, pancakes, yoghurt, quark, potatoes and fries, nuts,
/// seeds and dried fruit (`SNACKVEG`: dried fruit counts by its ingredient
/// class), fresh meat, fish, dairy, fats, spices, other drinks.
const CLASSES: &[(&str, Option<FoodCategory>)] = &[
    // Sweets and snacks: confectionery, sweet bakery, desserts, crisps, sugar.
    ("BAKSWEET", Some(SweetsSnacks)),
    ("BISCUSWE", Some(SweetsSnacks)),
    ("BUN", Some(SweetsSnacks)),
    ("CERBAR", Some(SweetsSnacks)),
    ("CHOCOL", Some(SweetsSnacks)),
    ("CHOCOLAT", Some(SweetsSnacks)),
    ("DESSAUCE", Some(SweetsSnacks)),
    ("ICECREAM", Some(SweetsSnacks)),
    ("JAM", Some(SweetsSnacks)),
    ("MILKPUDD", Some(SweetsSnacks)),
    ("SNACKSAV", Some(SweetsSnacks)),
    ("SUGADD", Some(SweetsSnacks)),
    ("SUGARSYR", Some(SweetsSnacks)),
    ("SWEET", Some(SweetsSnacks)),
    // Sugary drinks: sugared soft, juice and sport drinks; juices.
    ("DRINKCO", Some(SugaryDrinks)),
    ("DRINKSO", Some(SugaryDrinks)),
    ("DRJUICE", Some(SugaryDrinks)),
    ("DRSPORT", Some(SugaryDrinks)),
    ("FBDRINK", Some(SugaryDrinks)),
    ("FRUBJUIC", Some(SugaryDrinks)),
    ("JUICE", Some(SugaryDrinks)),
    ("SDRINK", Some(SugaryDrinks)),
    // Fruit and vegetables (WHO 5-a-day): pulses yes; potatoes, nuts, juices
    // no.
    ("APPLE", Some(FruitVeg)),
    ("BABFRUB", Some(FruitVeg)),
    ("BABVEGE", Some(FruitVeg)),
    ("BERFRESH", Some(FruitVeg)),
    ("BERRY", Some(FruitVeg)),
    ("CABBAGE", Some(FruitVeg)),
    ("CITRUS", Some(FruitVeg)),
    ("FRUBSAL", Some(FruitVeg)),
    ("FRUFRESH", Some(FruitVeg)),
    ("FRUITCAN", Some(FruitVeg)),
    ("FRUITOTH", Some(FruitVeg)),
    ("HERB", Some(FruitVeg)),
    ("LEGUMES", Some(FruitVeg)),
    ("MUSHRO", Some(FruitVeg)),
    ("PEABEAN", Some(FruitVeg)),
    ("ROOT", Some(FruitVeg)),
    ("SALADVEG", Some(FruitVeg)),
    ("VEGCANN", Some(FruitVeg)),
    ("VEGFRESH", Some(FruitVeg)),
    ("VEGFRU", Some(FruitVeg)),
    ("VEGLEAF", Some(FruitVeg)),
    ("VEGONI", Some(FruitVeg)),
    ("VEGPOT", Some(FruitVeg)),
    // Processed meat (IARC: salted, cured, smoked): sausages, cold cuts, meat
    // products.
    ("MEATCUTS", Some(ProcessedMeat)),
    ("MEATPROD", Some(ProcessedMeat)),
    ("SAUSAGE", Some(ProcessedMeat)),
    ("SAUSCUTS", Some(ProcessedMeat)),
    // None, so the ingredient class can't make a diet cola, flavoured water,
    // vegetable juice or long drink a sugary drink or fruit & veg.
    ("ALCOTH", None),
    ("BEER", None),
    ("CIDER", None),
    ("DRINKART", None),
    ("DRWATER", None),
    ("SPIRIT", None),
    ("VEGJUICE", None),
    ("WINE", None),
    // None: mixed dishes, soups and sauces, whatever their ingredient class.
    ("BABFISHD", None),
    ("BABMEATD", None),
    ("BAKSALT", None),
    ("EGGMIX", None),
    ("FISHDISH", None),
    ("FISHSAUC", None),
    ("FISHSOUP", None),
    ("FRUBDISH", None),
    ("FRUBSOUP", None),
    ("LEGUDISH", None),
    ("LEGUSAUC", None),
    ("LEGUSOUP", None),
    ("MEATDISH", None),
    ("MEATSAUC", None),
    ("MEATSOUP", None),
    ("MUSHRDI", None),
    ("OFFALDI", None),
    ("PIZZA", None),
    ("POTADISH", None),
    ("POULSAUC", None),
    ("POULTDIS", None),
    ("POULTSOU", None),
    ("SALADMAY", None),
    ("SALADMIX", None),
    ("SANDWICH", None),
    ("SEAFDISH", None),
    ("SEAFSAUC", None),
    ("SEAFSOUP", None),
    ("VEGDISH", None),
    ("VEGSAUC", None),
    ("VEGSOUP", None),
];

/// The food-use classes (`FUCLASS`) whose foods are drunk: coffee, tea,
/// water, soft, juice and sport drinks, juices, alcohol, milks and soured
/// milks, and plant drinks (`VEGJUICE` holds soy, oat and nut drinks).
/// From the release's `fuclass_EN.csv`. Spoonable cultured milk (`viili`),
/// ice cream and cream substitutes have other use classes.
const DRINK_CLASSES: [&str; 19] = [
    "ALCOTH", "BEER", "CIDER", "COFFEE", "DRINKART", "DRINKOTH", "DRINKSO", "DRJUICE", "DRSPORT",
    "DRWATER", "FRUBJUIC", "MILKFF", "MILKHF", "MILKLF", "SMILK", "SPIRIT", "TEA", "VEGJUICE",
    "WINE",
];

/// The category of a food in classes `fuclass` and `igclass`, by `table`.
fn category_of(
    table: &[(&str, Option<FoodCategory>)],
    fuclass: &str,
    igclass: &str,
) -> Option<FoodCategory> {
    let find = |code: &str| table.iter().find(|(c, _)| *c == code).map(|&(_, cat)| cat);
    find(fuclass).or_else(|| find(igclass)).flatten()
}

/// Fineli household units worth offering as servings, with their label.
const UNITS: [(&str, &str); 10] = [
    ("PORTS", "small portion"),
    ("PORTM", "portion"),
    ("PORTL", "large portion"),
    ("KPL_S", "small piece"),
    ("KPL_M", "piece"),
    ("KPL_L", "large piece"),
    ("KPL_VALM", "piece (package)"),
    ("DL", "dl"),
    ("RKL", "tbsp"),
    ("TL", "tsp"),
];

/// The labels of the servings Fineli gives; a re-import replaces these and
/// keeps any others (yours).
#[must_use]
pub fn serving_labels() -> Vec<&'static str> {
    UNITS.iter().map(|(_, label)| *label).collect()
}
/// Add or update foods read with [`read`], with their
/// [`ingredient_classes`], in one transaction; returns how many were new.
///
/// # Errors
/// Fails on a database error; nothing is written then.
pub fn store(
    conn: &mut Connection,
    foods: &[(i64, FoodInput)],
    classes: &[(i64, String)],
) -> Result<usize, Error> {
    let checked = foods
        .iter()
        .map(|(id, food)| {
            let food = food
                .clone()
                .checked()
                .map_err(|e| Error::invalid(format!("Fineli food {id}: {e}")))?;
            Ok((*id, food))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    db::food_upsert_fineli(conn, &checked, &serving_labels(), classes)
}

/// Each food's ingredient class (`IGCLASS`: `BEEF`, `POTATO`) in the
/// package in `dir`, by `FOODID`: what All time counts beef and potatoes by.
/// A cooked food is `DISH` whatever it is, so one that is plainly its
/// ingredient takes that ingredient's class (see [`dish_class`]).
///
/// # Errors
/// `food.csv` is missing or malformed.
pub fn ingredient_classes(dir: &Path) -> Result<Vec<(i64, String)>, Error> {
    let path = dir.join("food.csv");
    let food = File::open(&path).map_err(|e| {
        Error::invalid(format!(
            "{}: {e}; is this a Fineli package?",
            path.display()
        ))
    })?;
    table(food, &["FOODID", "FOODNAME", "IGCLASS", "FUCLASS"])?
        .into_iter()
        .map(|row| {
            let class = match row[2].as_str() {
                "DISH" => dish_class(&row[1], &row[3]).unwrap_or("DISH"),
                other => other,
            };
            Ok((id(&row[0])?, class.to_owned()))
        })
        .collect()
}

/// The ingredient class a cooked Fineli food (`IGCLASS` `DISH`) counts as
/// by its use class `fuclass` and `name`: cooked plain potato (`POTACOOK`:
/// boiled, baked) is `POTATO`; a steak or chop (`MSTEAK`) of beef alone is
/// `BEEF`. Other dishes count as neither.
// ponytail: whole-weight by class; decompose dishes through contribfood.csv
// if mixed dishes (stews, casseroles) should count their share.
fn dish_class(name: &str, fuclass: &str) -> Option<&'static str> {
    let name = name.to_uppercase();
    match fuclass {
        "POTACOOK" => Some("POTATO"),
        "MSTEAK"
            if ["NAUDAN", "NAUTA", "HÄRÄN", "VASIKAN"]
                .iter()
                .any(|n| name.contains(n))
                && !name.contains("SIKA")
                && !name.contains("SIAN") =>
        {
            Some("BEEF")
        }
        _ => None,
    }
}

/// Read the foods of an unzipped Fineli package in `dir`, each with its
/// Fineli `FOODID`.
///
/// # Errors
/// Fails if a file is missing or malformed.
pub fn read(dir: &Path) -> Result<Vec<(i64, FoodInput)>, Error> {
    let open = |name: &str| {
        let path = dir.join(name);
        File::open(&path).map_err(|e| {
            Error::invalid(format!(
                "{}: {e}; is this a Fineli package?",
                path.display()
            ))
        })
    };
    parse(
        open("food.csv")?,
        open("component_value.csv")?,
        open("foodaddunit.csv")?,
        CLASSES,
    )
}

/// Foods from the three Fineli files, in `food.csv` order, categorised by
/// `classes` (see [`CLASSES`]).
///
/// # Errors
/// Fails if a column is missing or a value isn't a number.
fn parse(
    food: impl Read,
    values: impl Read,
    units: impl Read,
    classes: &[(&str, Option<FoodCategory>)],
) -> Result<Vec<(i64, FoodInput)>, Error> {
    let mut per100: HashMap<i64, Nutrients> = HashMap::new();
    let factors: HashMap<&str, (&str, f64)> = COMPONENTS
        .iter()
        .map(|&(code, key, factor)| (code, (key, factor)))
        .collect();
    let mut retinol: HashMap<i64, f64> = HashMap::new();
    for row in table(values, &["FOODID", "EUFDNAME", "BESTLOC"])? {
        if row[1] == "RETOL" {
            if let Some(value) = number(&row[2])? {
                retinol.insert(id(&row[0])?, value);
            }
            continue;
        }
        let Some(&(key, factor)) = factors.get(row[1].as_str()) else {
            continue;
        };
        if let Some(value) = number(&row[2])? {
            per100
                .entry(id(&row[0])?)
                .or_default()
                .insert(key, value * factor);
        }
    }

    let labels: HashMap<&str, &str> = UNITS.into_iter().collect();
    let mut servings: HashMap<i64, Vec<Serving>> = HashMap::new();
    for row in table(units, &["FOODID", "FOODUNIT", "MASS"])? {
        let (Some(label), Some(grams)) = (labels.get(row[1].as_str()), number(&row[2])?) else {
            continue;
        };
        if grams > 0.0 {
            servings.entry(id(&row[0])?).or_default().push(Serving {
                label: (*label).to_owned(),
                grams,
            });
        }
    }

    table(food, &["FOODID", "FOODNAME", "FUCLASS", "IGCLASS"])?
        .into_iter()
        .map(|row| {
            let id = id(&row[0])?;
            let mut per100 = per100.remove(&id).unwrap_or_default();
            // Vitamin A as EFSA's targets and the EU NRV count it, retinol
            // equivalents (RE: β-carotene 6:1, other provitamin A
            // carotenoids 12:1; EFSA NDA, EFSA Journal 2015;13(3):4028),
            // not Fineli's RAE (12:1, 24:1): RE = 2 × RAE − retinol. No
            // retinol given (4 foods), it can't be told: unknown.
            if let Some(rae) = per100.get("vitamin_a") {
                match retinol.get(&id) {
                    Some(r) => per100.insert("vitamin_a", 2.0 * rae - r),
                    None => per100 = per100.without("vitamin_a"),
                }
            }
            // Fineli keeps withdrawn foods, marked `(ARC)`; they stay archived.
            let (name, archived) = match row[1].strip_prefix("(ARC)") {
                Some(name) => (name, true),
                None => (row[1].as_str(), false),
            };
            let food = FoodInput {
                name: sentence_case(name),
                brand: Some("Fineli".to_owned()),
                barcode: None,
                per100,
                servings: servings.remove(&id).unwrap_or_default(),
                archived,
                category: category_of(classes, &row[2], &row[3]).map(|c| c.as_str().to_owned()),
                basis: None,
                rev: None,
                uid: None,
                drink: Some(DRINK_CLASSES.contains(&row[2].as_str())),
            };
            Ok((id, food))
        })
        .collect()
}

/// One Fineli food class in a package: which list it's from (`FUCLASS` or
/// `IGCLASS`), its code and name, how many foods are in it and the
/// category [`CLASSES`] gives it.
#[derive(Debug, PartialEq)]
pub struct Class {
    pub kind: &'static str,
    pub code: String,
    pub name: Option<String>,
    pub foods: usize,
    pub category: Option<FoodCategory>,
}

/// Every food class of the package in `dir`, by kind, then code: what
/// [`CLASSES`] is filled from. Names come from the package's
/// `fuclass_*.csv`/`igclass_*.csv` (`THSCODE`, `DESCRIPT`; English when
/// there, else the first found), when it has them.
///
/// # Errors
/// `food.csv` is missing or malformed.
pub fn classes(dir: &Path) -> Result<Vec<Class>, Error> {
    let path = dir.join("food.csv");
    let food = File::open(&path).map_err(|e| {
        Error::invalid(format!(
            "{}: {e}; is this a Fineli package?",
            path.display()
        ))
    })?;
    let rows = table(food, &["FUCLASS", "IGCLASS"])?;
    let mut out = Vec::new();
    for (column, kind) in [(0, "FUCLASS"), (1, "IGCLASS")] {
        let names = class_names(dir, &kind.to_lowercase())?;
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for row in &rows {
            *counts.entry(row[column].as_str()).or_default() += 1;
        }
        out.extend(counts.into_iter().map(|(code, foods)| {
            Class {
                kind,
                code: code.to_owned(),
                name: names.get(code).cloned(),
                foods,
                category: CLASSES
                    .iter()
                    .find(|(c, _)| *c == code)
                    .and_then(|&(_, cat)| cat),
            }
        }));
    }
    Ok(out)
}

/// Class code → name from the package's `<prefix>_*.csv`, English first;
/// empty when it has none.
fn class_names(dir: &Path, prefix: &str) -> Result<HashMap<String, String>, Error> {
    let unreadable = |e: std::io::Error| Error::invalid(format!("{}: {e}", dir.display()));
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(unreadable)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|e| e.eq_ignore_ascii_case("csv"))
                && p.file_name()
                    .is_some_and(|n| n.to_string_lossy().to_lowercase().starts_with(prefix))
        })
        .collect();
    files.sort_by_key(|p| {
        !p.file_name()
            .is_some_and(|n| n.to_string_lossy().to_lowercase().contains("_en"))
    });
    let Some(file) = files.first() else {
        return Ok(HashMap::new());
    };
    Ok(table(
        File::open(file).map_err(unreadable)?,
        &["THSCODE", "DESCRIPT"],
    )?
    .into_iter()
    .map(|row| (row[0].clone(), row[1].clone()))
    .collect())
}

/// Rows of a Fineli CSV file, reduced to the named columns in that order.
fn table(input: impl Read, columns: &[&str]) -> Result<Vec<Vec<String>>, Error> {
    let mut reader = csv::ReaderBuilder::new().delimiter(b';').from_reader(input);
    let headers = reader.byte_headers()?.clone();
    let positions = columns
        .iter()
        .map(|name| {
            headers
                .iter()
                .position(|h| h == name.as_bytes())
                .ok_or_else(|| Error::invalid(format!("missing Fineli column {name:?}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    reader
        .byte_records()
        .map(|record| {
            let record = record?;
            Ok(positions
                .iter()
                .map(|&i| latin1(record.get(i).unwrap_or_default()))
                .collect())
        })
        .collect()
}

/// Fineli files are Latin-1, whose bytes are the first 256 code points.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().copied().map(char::from).collect()
}

fn id(text: &str) -> Result<i64, Error> {
    text.parse()
        .map_err(|_| Error::invalid(format!("bad Fineli food id {text:?}")))
}

/// A Fineli number: decimal comma, empty when unknown.
fn number(text: &str) -> Result<Option<f64>, Error> {
    if text.is_empty() {
        return Ok(None);
    }
    text.replace(',', ".")
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(Some)
        .ok_or_else(|| Error::invalid(format!("bad Fineli number {text:?}")))
}

/// Fineli names are upper case: `MAITO, RASVATON` reads `Maito, rasvaton`.
fn sentence_case(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let mut chars = lower.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Latin-1 bytes, as Fineli ships them.
    fn latin1_bytes(text: &str) -> Vec<u8> {
        text.chars()
            .map(|c| u8::try_from(u32::from(c)).expect("Latin-1 text"))
            .collect()
    }

    #[test]
    fn a_plain_cooked_food_takes_its_ingredient_class() {
        let class = dish_class;
        assert_eq!(
            class("PERUNA, KUORINEEN, KEITETTY, SUOLAA", "POTACOOK"),
            Some("POTATO")
        );
        assert_eq!(class("NAUDANLIHAPIHVI, PAISTETTU", "MSTEAK"), Some("BEEF"));
        assert_eq!(class("JAUHELIHA, SIKA-NAUTA, PAISTETTU", "MSTEAK"), None);
        assert_eq!(class("KERMAPERUNA", "POTADISH"), None);
    }

    /// A package's dishes take their ingredient's class where plain; other
    /// classes are kept as they are.
    #[test]
    fn a_packages_dishes_are_classed_by_ingredient() {
        let dir = std::env::temp_dir().join(format!("kaloriina-classes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("food.csv"),
            latin1_bytes(
                "FOODID;FOODNAME;FOODTYPE;IGCLASS;FUCLASS\n\
                 1;PERUNA, KUORINEEN, KEITETTY;FOOD;DISH;POTACOOK\n\
                 2;NAUDANLIHAPIHVI, PAISTETTU;FOOD;DISH;MSTEAK\n\
                 3;JAUHELIHA, SIKA-NAUTA, PAISTETTU;FOOD;DISH;MSTEAK\n\
                 4;KERMAPERUNA;FOOD;DISH;POTADISH\n\
                 5;JAUHELIHA, NAUTA, 10 %;FOOD;BEEF;MEATRAW\n",
            ),
        )
        .unwrap();
        let classes = ingredient_classes(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        let classes: Vec<(i64, &str)> = classes
            .as_ref()
            .unwrap()
            .iter()
            .map(|(id, c)| (*id, c.as_str()))
            .collect();
        assert_eq!(
            classes,
            [
                (1, "POTATO"),
                (2, "BEEF"),
                (3, "DISH"),
                (4, "DISH"),
                (5, "BEEF")
            ]
        );
    }

    #[test]
    fn every_key_is_in_the_registry() {
        for (_, key, _) in COMPONENTS {
            assert!(crate::nutrients::find(key).is_some(), "{key}");
        }
    }

    #[test]
    fn reads_names_values_and_servings() {
        let food = latin1_bytes(
            "FOODID;FOODNAME;FOODTYPE;IGCLASS;FUCLASS\n2;FRUKTOOSI, HEDELMÄSOKERI;FOOD;SUGAR;SUGADD\n7;VESI;FOOD;WATER;DRWATER\n9;(ARC)VANHA LEIPÄ;FOOD;BREAD;BREAD\n",
        );
        let values = latin1_bytes(
            "FOODID;EUFDNAME;BESTLOC;ACQTYPE\n\
             2;ENERC;1698,30;S\n\
             2;CHOAVL;99,9;S\n\
             2;FIBC;0,5;S\n\
             2;VITD;1,5;S\n\
             2;VITC;5,50;S\n\
             2;VITA;243,81;S\n\
             2;RETOL;0,5;S\n\
             7;VITA;10;S\n\
             2;F18D3N3;250;S\n\
             2;NA;3;S\n\
             2;CHOCDF;99,88;S\n\
             2;FAT;;S\n",
        );
        let units = latin1_bytes("FOODID;FOODUNIT;MASS\n2;TL;4,00\n2;KG;1000\n2;DL;0\n");
        let foods = parse(
            food.as_slice(),
            values.as_slice(),
            units.as_slice(),
            CLASSES,
        )
        .unwrap();

        assert_eq!(foods.len(), 3);
        let (id, f) = &foods[0];
        assert_eq!(*id, 2);
        assert_eq!(f.name, "Fruktoosi, hedelmäsokeri");
        assert_eq!(f.brand.as_deref(), Some("Fineli"));
        let get = |k: &str| f.per100.get(k).unwrap();
        assert_close!(get("energy"), 1698.3 / 4.184);
        assert_close!(get("net_carbs"), 99.9);
        assert_close!(get("vitamin_d"), 60.0, "µg to IU");
        assert_close!(get("vitamin_c"), 5.5, "vitamin C, mg");
        // 2 × RAE − retinol: β-carotene 6:1, other carotenoids 12:1 (EFSA RE).
        assert_close!(get("vitamin_a"), 487.12, "RAE to RE");
        assert_close!(get("ala"), 0.25, "mg to g");
        assert_close!(get("sodium"), 3.0);
        assert_eq!(f.per100.get("fat"), None, "unknown stays unknown");
        assert_eq!(
            f.servings,
            vec![Serving {
                label: "tsp".into(),
                grams: 4.0
            }],
            "only household units with a weight"
        );
        assert!(
            foods[1].1.per100.is_empty(),
            "no retinol: RE unknown, so no vitamin A"
        );
        assert!(!foods[1].1.archived);
        // Drunk by its use class, whatever its ingredient class.
        assert_eq!(
            foods.iter().map(|(_, f)| f.drink).collect::<Vec<_>>(),
            [Some(false), Some(true), Some(false)]
        );
        let (_, withdrawn) = &foods[2];
        assert_eq!(withdrawn.name, "Vanha leipä", "withdrawn marker stripped");
        assert!(withdrawn.archived, "withdrawn foods stay out of search");
    }

    #[test]
    fn rejects_files_that_are_not_fineli() {
        let err = parse(&b"a;b\n"[..], &b""[..], &b""[..], CLASSES).unwrap_err();
        assert!(err.to_string().contains("FOODID"), "{err}");
        let food = b"FOODID;FOODNAME;FUCLASS;IGCLASS\n1;X;A;B\n";
        let values = b"FOODID;EUFDNAME;BESTLOC\n1;FAT;lots\n";
        let units = b"FOODID;FOODUNIT;MASS\n";
        let err = parse(&food[..], &values[..], &units[..], CLASSES).unwrap_err();
        assert!(err.to_string().contains("lots"), "{err}");
    }

    #[test]
    fn a_dish_rounded_over_100_g_imports() {
        // Fineli_Rel20 publishes calculated dishes at 101.28 g water per 100 g.
        let mut conn = crate::open(Path::new(":memory:")).unwrap();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
        let foods = read(&dir).unwrap();
        let (_, dish) = foods.iter().find(|(id, _)| *id == 6026).unwrap();
        assert_close!(dish.per100.get("water").unwrap(), 101.28);
        assert_eq!(store(&mut conn, &foods, &[]).unwrap(), 4);
    }

    /// Synthetic codes: the real ones come from a package (see [`CLASSES`]).
    const TABLE: &[(&str, Option<FoodCategory>)] = &[
        ("FU_SWEET", Some(SweetsSnacks)),
        ("FU_DISH", None),
        ("IG_FRUIT", Some(FruitVeg)),
        ("IG_MEAT", Some(ProcessedMeat)),
    ];

    fn package(rows: &str) -> Vec<(i64, FoodInput)> {
        let food = format!("FOODID;FOODNAME;FOODTYPE;IGCLASS;FUCLASS\n{rows}");
        let values = b"FOODID;EUFDNAME;BESTLOC\n";
        let units = b"FOODID;FOODUNIT;MASS\n";
        parse(
            latin1_bytes(&food).as_slice(),
            &values[..],
            &units[..],
            TABLE,
        )
        .unwrap()
    }

    #[test]
    fn classes_map_to_categories() {
        let foods = package(
            "1;OMENA;FOOD;IG_FRUIT;FU_OTHER\n\
             2;HILLOMUNKKI;FOOD;IG_FRUIT;FU_SWEET\n\
             3;MAKKARA;FOOD;IG_MEAT;FU_OTHER\n\
             4;LEIPÄ;FOOD;IG_BREAD;FU_BREAD\n\
             5;MAKKARAKEITTO;FOOD;IG_MEAT;FU_DISH\n",
        );
        let category = |i: usize| foods[i].1.category.as_deref();
        assert_eq!(category(0), Some("fruit_veg"), "by IGCLASS");
        assert_eq!(category(1), Some("sweets_snacks"), "FUCLASS first");
        assert_eq!(category(2), Some("processed_meat"));
        assert_eq!(category(3), None, "unlisted classes have none");
        assert_eq!(category(4), None, "a FUCLASS listed as none stops");
    }

    #[test]
    fn the_class_table_is_one_entry_per_code_and_never_fast_food() {
        let mut codes: Vec<_> = CLASSES.iter().map(|(code, _)| *code).collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), CLASSES.len(), "a code listed twice");
        for (code, c) in CLASSES {
            assert_ne!(*c, Some(FoodCategory::FastFood), "{code}");
        }
    }

    #[test]
    fn real_classes_categorise_a_package() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
        let foods = read(&dir).unwrap();
        let category = |id: i64| {
            let (_, food) = foods.iter().find(|(i, _)| *i == id).unwrap();
            food.category.clone()
        };
        assert_eq!(category(101).as_deref(), Some("processed_meat"), "sausage");
        assert_eq!(
            category(102).as_deref(),
            Some("sugary_drinks"),
            "soft drink"
        );
        assert_eq!(category(6026), None, "a meat dish");
    }

    #[test]
    fn reimport_keeps_a_users_category() {
        let mut conn = crate::open(Path::new(":memory:")).unwrap();
        let first = package(
            "1;OMENA;FOOD;IG_FRUIT;FU_OTHER\n\
             2;MAKKARA;FOOD;IG_MEAT;FU_OTHER\n\
             3;LEIPÄ;FOOD;IG_BREAD;FU_BREAD\n",
        );
        store(&mut conn, &first, &[]).unwrap();
        let id = |name: &str| -> i64 {
            conn.query_row("SELECT id FROM food WHERE name = ?", [name], |r| r.get(0))
                .unwrap()
        };
        let (apple, sausage, bread) = (id("Omena"), id("Makkara"), id("Leipä"));
        // Yours: the sausage is a sweet now, as far as you're concerned.
        let food = db::food_get(&conn, sausage).unwrap().unwrap();
        let mine = FoodInput {
            name: food.name,
            brand: food.brand,
            per100: food.per100,
            category: Some("sweets_snacks".into()),
            rev: Some(food.rev),
            ..FoodInput::default()
        };
        db::food_update(&mut conn, sausage, &mine).unwrap();
        // A later release classifies all three differently.
        let second = package(
            "1;OMENA;FOOD;IG_MEAT;FU_OTHER\n\
             2;MAKKARA;FOOD;IG_FRUIT;FU_OTHER\n\
             3;LEIPÄ;FOOD;IG_BREAD;FU_SWEET\n",
        );
        store(&mut conn, &second, &[]).unwrap();
        let now = |id| -> (Option<String>, bool) {
            conn.query_row(
                "SELECT category, category_auto FROM food WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(
            now(apple),
            (Some("processed_meat".into()), true),
            "importer's: follows"
        );
        assert_eq!(
            now(sausage),
            (Some("sweets_snacks".into()), false),
            "yours: kept"
        );
        assert_eq!(
            now(bread),
            (Some("sweets_snacks".into()), true),
            "none: set"
        );
    }

    #[test]
    fn reimport_keeps_a_category_you_cleared() {
        let mut conn = crate::open(Path::new(":memory:")).unwrap();
        store(&mut conn, &package("1;SUKLAA;FOOD;IG_X;FU_SWEET\n"), &[]).unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM food WHERE name = 'Suklaa'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let food = db::food_get(&conn, id).unwrap().unwrap();
        assert_eq!(food.category.as_deref(), Some("sweets_snacks"));
        let mine = FoodInput {
            name: food.name,
            brand: food.brand,
            per100: food.per100,
            category: None,
            rev: Some(food.rev),
            ..FoodInput::default()
        };
        db::food_update(&mut conn, id, &mine).unwrap();
        store(&mut conn, &package("1;SUKLAA;FOOD;IG_X;FU_SWEET\n"), &[]).unwrap();
        let after = db::food_get(&conn, id).unwrap().unwrap();
        assert_eq!(after.category, None, "you said none: kept");
    }

    #[test]
    fn classes_lists_every_code_with_its_name_and_count() {
        let dir = std::env::temp_dir().join(format!("kaloriina-fineli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("food.csv"),
            latin1_bytes(
                "FOODID;FOODNAME;FOODTYPE;IGCLASS;FUCLASS\n\
                 1;OMENA;FOOD;FRUIT;FRUITFU\n2;PÄÄRYNÄ;FOOD;FRUIT;FRUITFU\n3;LEIPÄ;FOOD;BREAD;BREADFU\n",
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("igclass_FI.csv"),
            latin1_bytes("THSCODE;DESCRIPT;LANG\nFRUIT;Hedelmät;FI\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join("igclass_EN.csv"),
            latin1_bytes("THSCODE;DESCRIPT;LANG\nFRUIT;Fruits;EN\nBREAD;Breads;EN\n"),
        )
        .unwrap();
        let list = classes(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let rows: Vec<_> = list
            .iter()
            .map(|c| (c.kind, c.code.as_str(), c.name.as_deref(), c.foods))
            .collect();
        assert_eq!(
            rows,
            [
                ("FUCLASS", "BREADFU", None, 1),
                ("FUCLASS", "FRUITFU", None, 2),
                ("IGCLASS", "BREAD", Some("Breads"), 1),
                ("IGCLASS", "FRUIT", Some("Fruits"), 2),
            ]
        );
    }
}
