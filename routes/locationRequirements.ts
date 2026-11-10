import express, { Request, Response } from 'express';
import LocationRequirement from '../models/LocationRequirement.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// PAVILION ALLOCATION HELPERS
// All allocation logic is data-driven from LocationRequirement records.
// No quantities or location names are hardcoded here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical sub-section names attached to a parent pavilion location.
 * These must exactly match the locationNames stored in LocationRequirement.
 * We detect "section" locations by checking if any DB record contains both
 * the parent name AND one of these tokens in its locationNames array,
 * OR if a record's locationNames array contains only section-style names.
 *
 * We identify Pavilion parent groups dynamically from the DB:
 *   – A "group" record has locationNames length > 1 (e.g. ["Kagitingan Hall – Section A", ...])
 *   – OR we look for records whose locationNames contain "Entire" for a known parent.
 *
 * The only convention we enforce: the string " – Entire" / "Section A/B/C" suffix
 * pattern is used to split a compound location into parent + sub.
 */

/** Separators we accept between base name and sub-location variant. */
const SUB_SEPARATORS = [' – ', ' - ', ': '];

/**
 * Split a location string into { base, sub } if it contains a recognised
 * separator, otherwise return { base: name, sub: '' }.
 */
function splitLocationName(name: string): { base: string; sub: string } {
  for (const sep of SUB_SEPARATORS) {
    const idx = name.indexOf(sep);
    if (idx !== -1) {
      return { base: name.slice(0, idx).trim(), sub: name.slice(idx + sep.length).trim() };
    }
  }
  return { base: name.trim(), sub: '' };
}

/**
 * Given a set of selected location strings (e.g. ["Kagitingan Hall – Section A",
 * "Kagitingan Hall – Section B", "Kalayaan Ballroom – Entire"]) and ALL
 * LocationRequirement records from the DB, compute the allocated requirements
 * for each selected location.
 *
 * Rules (all data-driven, no hardcoded quantities):
 *
 * 1. For each LocationRequirement record whose locationNames array EXACTLY
 *    matches a set of selected locations (or is a single selected location),
 *    use its requirements directly.
 *
 * 2. For pavilion-style locations that share a common base name and whose
 *    DB record groups multiple sub-locations together (e.g. the record stores
 *    combined totals for Section A + B + C), distribute quantities evenly
 *    among the matching sub-sections that the user actually selected.
 *
 * 3. The "Entire" sub-location of a base consolidates without duplicating: it
 *    receives the full combined total as-is from the DB record (no distribution).
 *
 * 4. Any location not found in any DB record gets an empty requirements list.
 */
async function computeAllocatedRequirements(
  selectedLocations: string[]
): Promise<Record<string, Array<{ name: string; quantity: number; source: string }>>> {
  // Load all LocationRequirement records once
  const allRecords = await LocationRequirement.find().lean();

  const result: Record<string, Array<{ name: string; quantity: number; source: string }>> = {};

  // ── Step 1: Group selected locations by their base name ───────────────────
  const byBase: Record<string, { subs: string[]; full: string[] }> = {};
  for (const loc of selectedLocations) {
    const { base, sub } = splitLocationName(loc);
    if (!byBase[base]) byBase[base] = { subs: [], full: [] };
    if (sub) byBase[base].subs.push(sub);
    byBase[base].full.push(loc);
  }

  // ── Step 2: For each base group, resolve requirements ────────────────────
  for (const [base, { subs, full }] of Object.entries(byBase)) {

    // ── 2a: Exact-match first ────────────────────────────────────────────────
    // If there is a record whose locationNames exactly equals the full selected
    // set for this base, use it verbatim (handles multi-location exact groups).
    const exactRecord = allRecords.find(r => {
      const names = [...r.locationNames].sort();
      const sel   = [...full].sort();
      return names.length === sel.length && names.every((n, i) => n === sel[i]);
    });

    if (exactRecord) {
      for (const loc of full) {
        result[loc] = exactRecord.requirements.map((req: any) => ({
          name: req.name,
          quantity: req.quantity,
          source: 'exact-match'
        }));
      }
      continue;
    }

    // ── 2b: Per-location exact-match ──────────────────────────────────────────
    // Try to find a record that contains ONLY this single location in its
    // locationNames array.
    for (const loc of full) {
      const singleRecord = allRecords.find(r =>
        r.locationNames.length === 1 && r.locationNames[0] === loc
      );
      if (singleRecord) {
        result[loc] = singleRecord.requirements.map((req: any) => ({
          name: req.name,
          quantity: req.quantity,
          source: 'single-location'
        }));
      }
    }

    // If every location in this base was resolved by single-record match, done.
    if (full.every(loc => result[loc] !== undefined)) continue;

    // ── 2c: Section-distribution logic ───────────────────────────────────────
    // Look for a "combined" record that:
    //   • has locationNames all sharing the same base, OR
    //   • has locationNames that includes one or more sub-sections of this base.
    // Then distribute its quantities proportionally among the selected sections.

    const sectionSubs   = subs.filter(s => s.toLowerCase() !== 'entire');
    const hasEntire     = subs.includes('Entire') || full.some(f => f === base);  // bare base = Entire

    // Find all records related to this base
    const relatedRecords = allRecords.filter(r =>
      r.locationNames.some(n => splitLocationName(n).base === base)
    );

    // Find the combined/group record (the one that holds the totals for sections)
    // Heuristic: pick the record whose locationNames are all section-style
    // (i.e. contain sub parts) and whose base names all match.
    const combinedRecord = relatedRecords.find(r =>
      r.locationNames.length > 1 &&
      r.locationNames.every(n => {
        const { base: b, sub: s } = splitLocationName(n);
        return b === base && s !== '' && s.toLowerCase() !== 'entire';
      })
    );

    // Find the "Entire" record for this base
    const entireRecord = relatedRecords.find(r =>
      r.locationNames.length === 1 &&
      (splitLocationName(r.locationNames[0]).sub.toLowerCase() === 'entire' ||
       r.locationNames[0] === base)
    );

    // Find individual per-section records (each has exactly one section location)
    const perSectionRecords = relatedRecords.filter(r =>
      r.locationNames.length === 1 &&
      (() => {
        const { base: b, sub: s } = splitLocationName(r.locationNames[0]);
        return b === base && s !== '' && s.toLowerCase() !== 'entire';
      })()
    );

    // ── Resolve section sub-locations ─────────────────────────────────────────
    for (const sub of sectionSubs) {
      const sectionLoc = full.find(f => splitLocationName(f).sub === sub)!;
      if (result[sectionLoc] !== undefined) continue; // already resolved

      // Priority 1: a dedicated per-section record
      const ownRecord = perSectionRecords.find(r => r.locationNames[0] === sectionLoc);
      if (ownRecord) {
        result[sectionLoc] = ownRecord.requirements.map((req: any) => ({
          name: req.name,
          quantity: req.quantity,
          source: 'per-section-record'
        }));
        continue;
      }

      // Priority 2: distribute from combined record
      if (combinedRecord) {
        // How many section sub-locations does the combined record represent?
        const totalSections = combinedRecord.locationNames.length;

        result[sectionLoc] = combinedRecord.requirements.map((req: any) => ({
          name: req.name,
          // Integer division; remainder stays with the combined total (no loss)
          quantity: Math.floor(req.quantity / totalSections),
          source: `distributed-from-combined (÷${totalSections})`
        }));
        continue;
      }

      // Fallback: no record found for this section
      result[sectionLoc] = [];
    }

    // ── Resolve "Entire" or bare-base location ────────────────────────────────
    const entireLocs = full.filter(f => {
      const { sub } = splitLocationName(f);
      return sub.toLowerCase() === 'entire' || f === base;
    });

    for (const entLoc of entireLocs) {
      if (result[entLoc] !== undefined) continue;

      if (entireRecord) {
        result[entLoc] = entireRecord.requirements.map((req: any) => ({
          name: req.name,
          quantity: req.quantity,
          source: 'entire-record'
        }));
      } else if (combinedRecord) {
        // Fallback: use combined totals as the "Entire" consolidated view
        result[entLoc] = combinedRecord.requirements.map((req: any) => ({
          name: req.name,
          quantity: req.quantity,
          source: 'combined-as-entire'
        }));
      } else {
        result[entLoc] = [];
      }
    }
  }

  // ── Step 3: Ensure every selected location has an entry ──────────────────
  for (const loc of selectedLocations) {
    if (result[loc] === undefined) result[loc] = [];
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/location-requirements/allocate
// Called by the frontend "Tag Departments" step (PGSO tagging) on the
// Request Event page to get allocated logistics per selected location(s).
//
// Body: { locations: string[] }
// Response: { allocations: Record<location, Requirement[]>, summary: {...} }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/allocate', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { locations } = req.body;

    if (!locations || !Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'locations array is required and must not be empty'
      });
    }

    const uniqueLocations: string[] = [...new Set(
      locations.map((l: any) => String(l).trim()).filter(Boolean)
    )];

    if (uniqueLocations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid location names provided'
      });
    }

    const rawAllocations = await computeAllocatedRequirements(uniqueLocations);

    // Strip internal source metadata before sending to client
    const allocations: Record<string, Array<{ name: string; quantity: number }>> = {};
    const summary: Array<{ location: string; requirementCount: number; items: Array<{ name: string; quantity: number }> }> = [];

    for (const loc of uniqueLocations) {
      const items = (rawAllocations[loc] || []).map(r => ({
        name: r.name,
        quantity: r.quantity
      }));
      allocations[loc] = items;
      summary.push({ location: loc, requirementCount: items.length, items });
    }

    console.log(`📦 [ALLOCATE] Resolved requirements for ${uniqueLocations.length} location(s):`,
      summary.map(s => `${s.location} → ${s.requirementCount} items`).join(', ')
    );

    return res.status(200).json({
      success: true,
      allocations,
      summary
    });
  } catch (error) {
    console.error('Error computing location allocations:', error);
    return res.status(500).json({
      success: false,
      message: 'Error computing location allocations',
      error: (error as Error).message
    });
  }
});

// Drop old index and migrate (run once after deleting old data)
router.post('/fix-index', authenticateToken, async (req: Request, res: Response) => {
  try {
    const collection = LocationRequirement.collection;
    
    // Drop the old locationName unique index
    try {
      await collection.dropIndex('locationName_1');
      console.log('✅ Dropped old locationName_1 index');
      res.json({
        message: 'Old index dropped successfully. You can now save new requirements.'
      });
    } catch (error: any) {
      if (error.code === 27 || error.codeName === 'IndexNotFound') {
        console.log('ℹ️ Index locationName_1 does not exist (already dropped)');
        res.json({
          message: 'Index already dropped or does not exist. You can now save new requirements.'
        });
      } else {
        console.error('Error dropping index:', error);
        throw error;
      }
    }
  } catch (error) {
    console.error('Error fixing index:', error);
    res.status(500).json({ message: 'Error fixing index', error: (error as Error).message });
  }
});

// Get all location requirements
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const requirements = await LocationRequirement.find()
      .populate('setBy', 'name email')
      .sort({ locationNames: 1 });
    
    res.json(requirements);
  } catch (error) {
    console.error('Error fetching location requirements:', error);
    res.status(500).json({ message: 'Error fetching location requirements' });
  }
});

// Get requirements for a specific location (searches in locationNames array)
router.get('/:locationName', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { locationName } = req.params;

    const locationNameStr = decodeURIComponent(String(locationName));
    
    const requirement = await LocationRequirement.findOne({ 
      locationNames: locationNameStr
    }).populate('setBy', 'name email');
    
    if (!requirement) {
      return res.json({ 
        locationNames: [locationNameStr],
        requirements: [] 
      });
    }
    
    res.json(requirement);
  } catch (error) {
    console.error('Error fetching location requirement:', error);
    res.status(500).json({ message: 'Error fetching location requirement' });
  }
});

// Create or update requirements for multiple locations
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { locationNames, requirements } = req.body;
    
    // req.user is the full User document, so use _id
    const userId = (req as any).user?._id;
    const departmentName = (req as any).user?.department || (req as any).user?.departmentName || 'PGSO';

    if (!locationNames || !Array.isArray(locationNames) || locationNames.length === 0) {
      return res.status(400).json({ message: 'At least one location name is required' });
    }
    
    if (!userId) {
      return res.status(400).json({ message: 'User ID not found in request' });
    }

    if (!Array.isArray(requirements)) {
      return res.status(400).json({ message: 'Requirements must be an array' });
    }

    // Validate requirements
    for (const req of requirements) {
      if (!req.name || typeof req.name !== 'string') {
        return res.status(400).json({ message: 'Each requirement must have a name' });
      }
      if (!req.quantity || typeof req.quantity !== 'number' || req.quantity < 1) {
        return res.status(400).json({ message: 'Each requirement must have a valid quantity' });
      }
    }

    // Sort locationNames for consistent comparison
    const sortedLocationNames = [...locationNames].sort();

    // Find existing document with the same set of locations
    const existingRequirement = await LocationRequirement.findOne({
      locationNames: { $all: sortedLocationNames, $size: sortedLocationNames.length }
    });

    let locationRequirement;
    if (existingRequirement) {
      // Update existing
      existingRequirement.requirements = requirements;
      existingRequirement.setBy = userId;
      existingRequirement.departmentName = departmentName;
      existingRequirement.updatedAt = new Date();
      locationRequirement = await existingRequirement.save();
      await locationRequirement.populate('setBy', 'name email');
    } else {
      // Create new
      locationRequirement = await LocationRequirement.create({
        locationNames: sortedLocationNames,
        requirements,
        setBy: userId,
        departmentName
      });
      await locationRequirement.populate('setBy', 'name email');
    }

    res.status(200).json({
      message: 'Location requirements saved successfully',
      data: locationRequirement
    });
  } catch (error) {
    console.error('Error saving location requirements:', error);
    res.status(500).json({ message: 'Error saving location requirements' });
  }
});

// Delete a specific requirement from a specific location entry
router.delete('/:locationKey/requirements/:requirementName', authenticateToken, async (req: Request, res: Response) => {
  try {
    const locationKey = decodeURIComponent(String(req.params.locationKey || ''));
    const requirementName = decodeURIComponent(String(req.params.requirementName || '')).trim();

    if (!locationKey) {
      return res.status(400).json({ message: 'locationKey is required' });
    }

    if (!requirementName) {
      return res.status(400).json({ message: 'requirementName is required' });
    }

    const locationNames = locationKey
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();

    if (locationNames.length === 0) {
      return res.status(400).json({ message: 'At least one location name is required' });
    }

    const existingRequirement = await LocationRequirement.findOne({
      locationNames: { $all: locationNames, $size: locationNames.length }
    });

    if (!existingRequirement) {
      return res.status(404).json({ message: 'Location requirements not found' });
    }

    const beforeCount = existingRequirement.requirements.length;
    existingRequirement.requirements = existingRequirement.requirements.filter((r: any) => {
      const n = typeof r?.name === 'string' ? r.name.trim() : '';
      return n !== requirementName;
    });

    if (existingRequirement.requirements.length === beforeCount) {
      return res.status(404).json({ message: 'Requirement not found' });
    }

    if (existingRequirement.requirements.length === 0) {
      const deleted = await LocationRequirement.findByIdAndDelete(existingRequirement._id);
      return res.json({
        message: 'Requirement deleted successfully (no requirements left; entry removed)',
        data: deleted
      });
    }

    existingRequirement.updatedAt = new Date();
    const saved = await existingRequirement.save();

    res.json({
      message: 'Requirement deleted successfully',
      data: saved
    });
  } catch (error) {
    console.error('Error deleting location requirement item:', error);
    res.status(500).json({ message: 'Error deleting location requirement item' });
  }
});

// Delete requirements by ID
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const result = await LocationRequirement.findByIdAndDelete(id);
    
    if (!result) {
      return res.status(404).json({ message: 'Location requirements not found' });
    }
    
    res.json({ 
      message: 'Location requirements deleted successfully',
      data: result
    });
  } catch (error) {
    console.error('Error deleting location requirements:', error);
    res.status(500).json({ message: 'Error deleting location requirements' });
  }
});

export default router;
