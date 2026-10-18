//! Photos on a day and group (ADR 0022): a JPEG the client already
//! shrank, taken only when its bytes are a JPEG, no side over
//! [`PHOTO_PX_MAX`].

use super::prelude::*;
use super::{checked_group, checked_uid};

text_enum! {
    /// The image types a photo may be.
    pub enum PhotoMime {
        Jpeg = "image/jpeg",
    }
}

/// Where a photo goes: its day and group, and the client's `uid` (a retry
/// stores nothing more). The upload's query.
#[derive(Debug, Clone, Deserialize)]
pub struct PhotoInput {
    pub day: String,
    pub group: String,
    #[serde(default)]
    pub uid: Option<String>,
}

impl PhotoInput {
    /// # Errors
    /// A bad day, group or uid, each naming its field.
    pub fn checked(self) -> Result<Self, Error> {
        if !is_date(&self.day) {
            return Err(Error::invalid_field("day", "day must be YYYY-MM-DD"));
        }
        let group = checked_group(&self.group)
            .map_err(|e| Error::invalid_field("group", e.to_string()))?
            .to_owned();
        if let Some(uid) = &self.uid {
            checked_uid(uid)?;
        }
        Ok(Self { group, ..self })
    }
}

/// A photo as listed (its bytes are served by `uid`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Photo {
    pub id: i64,
    pub uid: String,
    pub day: String,
    pub group: String,
    /// When it was stored, epoch milliseconds.
    pub taken_at: i64,
    pub mime: PhotoMime,
    /// Its bytes' length.
    pub size: i64,
}

/// Whether `bytes` are a `mime` image whose frame size reads, each side at
/// most [`PHOTO_PX_MAX`].
///
/// # Errors
/// Bytes of another kind, no frame size, or a side too long.
pub fn checked_image(mime: PhotoMime, bytes: &[u8]) -> Result<(), Error> {
    let (w, h) = match mime {
        PhotoMime::Jpeg => jpeg_size(bytes),
    }
    .ok_or_else(|| Error::invalid(format!("the body must be a {} image", mime.as_str())))?;
    if w == 0 || h == 0 || w > PHOTO_PX_MAX || h > PHOTO_PX_MAX {
        return Err(Error::invalid(format!(
            "a photo is at most {PHOTO_PX_MAX} px a side"
        )));
    }
    Ok(())
}

fn be16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes(
        b.get(at..at + 2)?.try_into().ok()?,
    )))
}

/// A JPEG's frame size: its markers walked from SOI to the first
/// start-of-frame (SOF0–SOF15 but DHT, JPG and DAC), before any scan.
fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    if !b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return None;
    }
    let mut at = 2;
    loop {
        if *b.get(at)? != 0xFF {
            return None;
        }
        let marker = *b.get(at + 1)?;
        match marker {
            // Fill bytes.
            0xFF => at += 1,
            // Markers without a length.
            0x01 | 0xD0..=0xD7 => at += 2,
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                return Some((be16(b, at + 7)?, be16(b, at + 5)?));
            }
            // A scan or the end before any frame.
            0xDA | 0xD9 => return None,
            _ => at += 2 + usize::try_from(be16(b, at + 2)?).ok()?,
        }
    }
}
