import sys
import json
import urllib.request
import cv2
import numpy as np

def parse_duration_to_seconds(dur_str):
    if not dur_str or not isinstance(dur_str, str):
        return None
    dur_str = dur_str.strip()
    parts = dur_str.split(':')
    try:
        parts = [int(p) for p in parts]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        elif len(parts) == 2:
            return parts[0] * 60 + parts[1]
        elif len(parts) == 1:
            return parts[0]
    except Exception:
        return None
    return None

def compare_thumbnails(screenshot_path, candidate_thumbs, target_duration_str=None):
    target = cv2.imread(screenshot_path)
    if target is None:
        return {'error': 'Could not read screenshot'}
        
    h, w, _ = target.shape
    
    if h > w * 1.5:
        thumb_crop = target[0:int(h * 0.45), 0:w]
    else:
        thumb_crop = target[0:int(h * 0.65), 0:w]

    sift = cv2.SIFT_create()
    kp_target, des_target = sift.detectAndCompute(thumb_crop, None)
    bf = cv2.BFMatcher()

    target_sec = parse_duration_to_seconds(target_duration_str)
    results = []

    for cand in candidate_thumbs:
        cid = cand.get('id')
        thumb_url = cand.get('thumbUrl') or f'https://img.youtube.com/vi/{cid}/hqdefault.jpg'
        cand_dur_str = cand.get('duration')
        
        cand_sec = parse_duration_to_seconds(cand_dur_str)
        duration_diff_pct = None
        duration_passed = True
        
        if target_sec is not None and cand_sec is not None and target_sec > 0:
            diff = abs(target_sec - cand_sec)
            duration_diff_pct = (diff / target_sec) * 100
            if duration_diff_pct > 5.0 and diff > 3:
                duration_passed = False

        visual_score = 0.0
        good_matches = 0
        try:
            req = urllib.request.Request(thumb_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=5) as resp:
                arr = np.asarray(bytearray(resp.read()), dtype=np.uint8)
                cand_img = cv2.imdecode(arr, cv2.IMREAD_COLOR)

            if cand_img is not None and des_target is not None and len(des_target) > 0:
                kp_cand, des_cand = sift.detectAndCompute(cand_img, None)
                if des_cand is not None and len(des_cand) > 0:
                    matches = bf.knnMatch(des_target, des_cand, k=2)
                    good = [m for m, n in matches if len(matches) > 1 and m.distance < 0.75 * n.distance]
                    good_matches = len(good)
                    visual_score = min(100.0, (good_matches / 30.0) * 100.0)
        except Exception:
            visual_score = 0.0

        dur_score = 100.0 if duration_passed else max(0.0, 100.0 - (duration_diff_pct or 100.0) * 5)
        combined_score = (visual_score * 0.70) + (dur_score * 0.30)

        results.append({
            'id': cid,
            'visualMatches': good_matches,
            'visualScore': round(visual_score, 1),
            'durationPassed': duration_passed,
            'durationDiffPct': round(duration_diff_pct, 1) if duration_diff_pct is not None else None,
            'combinedScore': round(combined_score, 1)
        })

    results.sort(key=lambda x: x['combinedScore'], reverse=True)
    return results

if __name__ == '__main__':
    try:
        input_data = json.loads(sys.argv[1])
        screenshot_path = input_data['screenshotPath']
        candidates = input_data['candidates']
        target_dur = input_data.get('duration')
        
        output = compare_thumbnails(screenshot_path, candidates, target_dur)
        print(json.dumps(output))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
