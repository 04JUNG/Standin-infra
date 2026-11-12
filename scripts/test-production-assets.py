import base64
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('promote',Path(__file__).with_name('promote-production-assets.py'))
promote=importlib.util.module_from_spec(spec);spec.loader.exec_module(promote)
class Client:
    def __init__(self,found):self.found=found;self.copied=[]
    def head_object(self,**kwargs):return self.found
    def copy_object(self,**kwargs):self.copied.append(kwargs)
class PromotionTests(unittest.TestCase):
    row={'key':'release/immutable','size':10,'etag':'"source"','sha256':'a'*64}
    def test_unknown_existing_bytes_are_never_replaced(self):
        c=Client({'ContentLength':10,'ETag':'"different"'})
        with self.assertRaisesRegex(ValueError,'refusing to replace'):promote.copy_one(c,'source','prod',self.row,True)
        self.assertFalse(c.copied)
    def test_multipart_identity_uses_full_s3_checksum(self):
        c=Client({'ContentLength':10,'ETag':'"different"','ChecksumSHA256':base64.b64encode(bytes.fromhex('a'*64)).decode()})
        self.assertEqual(promote.copy_one(c,'source','prod',self.row,True),'existing');self.assertFalse(c.copied)
    def test_wrong_size_denies_even_matching_checksum(self):
        c=Client({'ContentLength':11,'ETag':'"source"','ChecksumSHA256':base64.b64encode(bytes.fromhex('a'*64)).decode()})
        with self.assertRaises(ValueError):promote.copy_one(c,'source','prod',self.row,True)
    def test_missing_plan_never_writes(self):
        original=promote.missing
        try:
            promote.missing=lambda *a:None;c=Client(None)
            self.assertEqual(promote.copy_one(c,'source','prod',self.row,False),'missing');self.assertFalse(c.copied)
        finally:promote.missing=original
    def test_new_copy_uses_atomic_destination_and_source_conditions(self):
        original=promote.missing
        try:
            promote.missing=lambda *a:None
            c=Client({'ContentLength':10,'ETag':'"copied"'})
            self.assertEqual(promote.copy_one(c,'source','prod',self.row,True),'copied')
            self.assertEqual(c.copied[0]['IfNoneMatch'],'*')
            self.assertEqual(c.copied[0]['CopySourceIfMatch'],'"source"')
        finally:promote.missing=original
if __name__=='__main__':unittest.main()
